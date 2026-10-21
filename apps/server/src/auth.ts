import {
  OAuthAuthorizationServer,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { base64url, fromBase64url, randomToken, secretMatches, sha256 } from './crypto';
import { AppError } from './errors';
import { resolveLocale } from './i18n';
import type { Actor, AuthProps, Env, IdentityProvider, Owner, OwnerSession } from './types';

const passkeyResponseSchema = z.record(z.string(), z.unknown());
const registrationOptionsSchema = z.object({ setupToken: z.string().max(1024).optional() });
const registrationSchema = z.object({
  response: passkeyResponseSchema,
  name: z.string().max(100).optional(),
});
function parseAuthInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      422,
      'INVALID_INPUT',
      'invalidInput',
      result.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    );
  return result.data;
}

export const FULL_SCOPE = 'fitness:full';
export const HEALTH_SCOPE = 'health:sync';
export function baseUrl(env: Env): string {
  if (!env.PUBLIC_BASE_URL) throw new AppError(503, 'PUBLIC_BASE_URL_REQUIRED', 'internalError');
  const url = new URL(env.PUBLIC_BASE_URL);
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  )
    throw new AppError(503, 'INVALID_PUBLIC_BASE_URL', 'internalError');
  return url.origin;
}
export function cookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    (request.headers.get('cookie') ?? '').split(';').flatMap((part) => {
      const index = part.indexOf('=');
      return index > 0 ? [[part.slice(0, index).trim(), part.slice(index + 1).trim()]] : [];
    }),
  );
}
export function safeReturn(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return '/admin';
  return value;
}
export function requireOrigin(request: Request, origin: string): void {
  if (request.headers.get('Origin') !== origin)
    throw new AppError(403, 'INVALID_ORIGIN', 'forbidden');
}
const OWNER_COLUMNS =
  'id, locale, time_zone, setup_completed, session_epoch, health_writer_device_id, clerk_user_id, email, status, created_at';
function prefixedOwnerColumns(alias: string): string {
  return OWNER_COLUMNS.split(', ')
    .map((column) => `${alias}.${column}`)
    .join(', ');
}
function ownerRecord(row: Owner): Owner {
  return {
    id: row.id,
    locale: row.locale,
    time_zone: row.time_zone,
    setup_completed: row.setup_completed,
    session_epoch: row.session_epoch,
    health_writer_device_id: row.health_writer_device_id,
    clerk_user_id: row.clerk_user_id,
    email: row.email,
    status: row.status,
    created_at: row.created_at,
  };
}
export class AuthService implements IdentityProvider {
  readonly origin: string;
  readonly sessionCookie: string;
  readonly authorizationServer: OAuthAuthorizationServer<Env>;
  constructor(public env: Env) {
    this.origin = baseUrl(env);
    this.sessionCookie = this.origin.startsWith('https:') ? '__Host-of_session' : 'of_session';
    this.authorizationServer = new OAuthAuthorizationServer<Env>({
      issuer: this.origin,
      resources: [this.origin],
      defaultResource: this.origin,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: [FULL_SCOPE, HEALTH_SCOPE, 'offline_access'],
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      refreshTokenTTL: 2592000,
      allowPrivateUseRedirectUris: true,
    });
  }
  helpers(): OAuthHelpers {
    return this.authorizationServer.getOAuthApi(this.env);
  }
  async owner(id = 'owner'): Promise<Owner> {
    const owner = await this.env.DB.prepare(`SELECT ${OWNER_COLUMNS} FROM owners WHERE id=?`)
      .bind(id)
      .first<Owner>();
    if (!owner) throw new AppError(503, 'DATABASE_NOT_MIGRATED', 'internalError');
    return owner;
  }
  async session(request: Request): Promise<OwnerSession | null> {
    const value = cookies(request)[this.sessionCookie];
    if (!value) return null;
    const tokenHash = await sha256(value);
    const row = await this.env.DB.prepare(
      `SELECT ${prefixedOwnerColumns('owners')}, s.epoch AS issued_epoch, s.expires_at
       FROM sessions s JOIN owners ON owners.id = s.owner_id WHERE s.token_hash=?`,
    )
      .bind(tokenHash)
      .first<Owner & { issued_epoch: number; expires_at: number }>();
    if (!row || row.expires_at <= Date.now() || row.issued_epoch !== row.session_epoch) return null;
    if (row.status !== 'active') return null;
    const owner = ownerRecord(row);
    return { owner, tokenHash, actor: this.ownerActor(owner, request) };
  }
  ownerActor(owner: Owner, request: Request): Actor {
    return {
      ownerId: owner.id,
      id: owner.id,
      kind: 'owner',
      locale: resolveLocale(
        owner.locale ?? cookies(request).of_locale,
        request.headers.get('Accept-Language') ?? '',
      ),
      timeZone: owner.time_zone,
      scopes: [FULL_SCOPE, HEALTH_SCOPE],
    };
  }
  async botActor(
    props: AuthProps,
    request: Request,
    scopes: readonly string[] = [FULL_SCOPE],
  ): Promise<Actor> {
    if (!props || typeof props.ownerId !== 'string' || typeof props.botId !== 'string')
      throw new AppError(401, 'INVALID_BOT_IDENTITY', 'unauthorized');
    const row = await this.env.DB.prepare(
      `SELECT ${prefixedOwnerColumns('owners')}, b.status AS bot_status, b.epoch AS bot_epoch, b.owner_id AS bot_owner_id
       FROM bots b JOIN owners ON owners.id = b.owner_id WHERE b.id=?`,
    )
      .bind(props.botId)
      .first<Owner & { bot_status: string; bot_epoch: number; bot_owner_id: string }>();
    if (
      !row ||
      row.bot_owner_id !== props.ownerId ||
      row.status !== 'active' ||
      row.bot_status !== 'active' ||
      row.bot_epoch !== row.session_epoch ||
      props.epoch !== row.session_epoch
    )
      throw new AppError(401, 'CONNECTION_REVOKED', 'unauthorized');
    const owner = ownerRecord(row);
    return { ...this.ownerActor(owner, request), id: props.botId, kind: 'bot', scopes };
  }
  cookie(name: string, value: string, seconds: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  async rateLimit(request: Request): Promise<void> {
    const key =
      'auth:rate:' +
      (await sha256(request.headers.get('CF-Connecting-IP') ?? 'local')) +
      ':' +
      Math.floor(Date.now() / 60000);
    const count = Number((await this.env.CACHE.get(key)) ?? 0);
    if (count >= 60) throw new AppError(429, 'AUTH_RATE_LIMITED', 'rateLimited');
    await this.env.CACHE.put(key, String(count + 1), { expirationTtl: 120 });
  }
  async registrationOptions(
    request: Request,
    raw: unknown,
  ): Promise<{ options: unknown; cookie: string }> {
    requireOrigin(request, this.origin);
    await this.rateLimit(request);
    const input = parseAuthInput(registrationOptionsSchema, raw);
    const session = await this.session(request);
    const owner = session?.owner ?? (await this.owner());
    const setup = !owner.setup_completed;
    if (setup) {
      if (
        !this.env.SETUP_TOKEN ||
        this.env.SETUP_TOKEN.length < 32 ||
        !input.setupToken ||
        !(await secretMatches(input.setupToken, this.env.SETUP_TOKEN))
      )
        throw new AppError(403, 'INVALID_SETUP_TOKEN', 'forbidden');
    } else if (!session) throw new AppError(401, 'SESSION_REQUIRED', 'unauthorized');
    const passkeys = await this.env.DB.prepare('SELECT id FROM passkeys WHERE owner_id=?')
      .bind(owner.id)
      .all<{ id: string }>();
    const options = await generateRegistrationOptions({
      rpName: 'OpenFitness',
      rpID: new URL(this.origin).hostname,
      // The original owner keeps the stable WebAuthn user handle already stored
      // on authenticators. Other owners get their own handle.
      userName: owner.id,
      userID: new TextEncoder().encode(owner.id === 'owner' ? 'openfitness-owner' : owner.id),
      attestationType: 'none',
      excludeCredentials: passkeys.results.map((key) => ({ id: key.id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
    });
    const challengeId = randomToken();
    await this.env.DB.prepare(
      'INSERT INTO auth_challenges(id,challenge,kind,session_hash,expires_at) VALUES(?,?,?,?,?)',
    )
      .bind(
        challengeId,
        options.challenge,
        setup ? 'setup' : 'register',
        session?.tokenHash ?? null,
        Date.now() + 300000,
      )
      .run();
    return { options, cookie: this.cookie('of_challenge', challengeId, 300) };
  }
  private async consumeChallenge(
    request: Request,
    kinds: string[],
  ): Promise<{ challenge: string; kind: string; session_hash: string | null }> {
    const challengeId = cookies(request).of_challenge;
    if (!challengeId) throw new AppError(401, 'CHALLENGE_REQUIRED', 'unauthorized');
    const challenge = await this.env.DB.prepare(
      'UPDATE auth_challenges SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>? RETURNING challenge,kind,session_hash',
    )
      .bind(Date.now(), challengeId, Date.now())
      .first<{ challenge: string; kind: string; session_hash: string | null }>();
    if (!challenge || !kinds.includes(challenge.kind))
      throw new AppError(401, 'INVALID_CHALLENGE', 'unauthorized');
    return challenge;
  }
  async register(request: Request, raw: unknown): Promise<string> {
    requireOrigin(request, this.origin);
    const input = parseAuthInput(registrationSchema, raw);
    const challenge = await this.consumeChallenge(request, ['setup', 'register']);
    const session = await this.session(request);
    let owner: Owner;
    if (challenge.kind === 'setup') {
      owner = await this.owner();
      if (owner.setup_completed) throw new AppError(403, 'SETUP_ALREADY_COMPLETED', 'forbidden');
    } else {
      if (!session || session.tokenHash !== challenge.session_hash)
        throw new AppError(401, 'SESSION_REQUIRED', 'unauthorized');
      owner = session.owner;
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: input.response as unknown as Parameters<
          typeof verifyRegistrationResponse
        >[0]['response'],
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: new URL(this.origin).hostname,
        requireUserVerification: true,
      });
    } catch {
      throw new AppError(401, 'INVALID_PASSKEY', 'unauthorized');
    }
    if (!verification.verified || !verification.registrationInfo)
      throw new AppError(401, 'INVALID_PASSKEY', 'unauthorized');
    const credential = verification.registrationInfo.credential;
    const statements: D1PreparedStatement[] = [];
    if (challenge.kind === 'setup')
      statements.push(
        this.env.DB.prepare('INSERT INTO bootstrap_claims(id) VALUES(?)').bind(owner.id),
      );
    statements.push(
      this.env.DB.prepare(
        'INSERT INTO passkeys(id,public_key,counter,transports,name,created_at,owner_id) VALUES(?,?,?,?,?,?,?)',
      ).bind(
        credential.id,
        base64url(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        input.name || 'Passkey',
        new Date().toISOString(),
        owner.id,
      ),
    );
    if (challenge.kind === 'setup') {
      const timeZone = this.env.DEFAULT_TIME_ZONE || 'America/New_York';
      try {
        new Intl.DateTimeFormat('en', { timeZone }).format();
      } catch {
        throw new AppError(503, 'INVALID_DEFAULT_TIME_ZONE', 'internalError');
      }
      statements.push(
        this.env.DB.prepare('UPDATE owners SET setup_completed=1,time_zone=? WHERE id=?').bind(
          timeZone,
          owner.id,
        ),
      );
    }
    const token = randomToken();
    statements.push(
      this.env.DB.prepare(
        'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,created_at) VALUES(?,?,?,?,?)',
      ).bind(
        await sha256(token),
        owner.session_epoch,
        Date.now() + 604800000,
        owner.id,
        Date.now(),
      ),
    );
    await this.env.DB.batch(statements);
    return this.cookie(this.sessionCookie, token, 604800);
  }
  async authenticationOptions(request: Request): Promise<{ options: unknown; cookie: string }> {
    requireOrigin(request, this.origin);
    await this.rateLimit(request);
    const options = await generateAuthenticationOptions({
      rpID: new URL(this.origin).hostname,
      userVerification: 'required',
    });
    const challengeId = randomToken();
    await this.env.DB.prepare(
      'INSERT INTO auth_challenges(id,challenge,kind,expires_at) VALUES(?,?,?,?)',
    )
      .bind(challengeId, options.challenge, 'authenticate', Date.now() + 300000)
      .run();
    return { options, cookie: this.cookie('of_challenge', challengeId, 300) };
  }
  async authenticate(request: Request, raw: unknown): Promise<string> {
    requireOrigin(request, this.origin);
    const response = parseAuthInput(passkeyResponseSchema, raw);
    const challenge = await this.consumeChallenge(request, ['authenticate']);
    const key = await this.env.DB.prepare('SELECT * FROM passkeys WHERE id=?')
      .bind(typeof response?.id === 'string' ? response.id : '')
      .first<{
        id: string;
        public_key: string;
        counter: number;
        transports: string;
        owner_id: string;
      }>();
    if (!key) throw new AppError(401, 'INVALID_PASSKEY', 'unauthorized');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: response as unknown as Parameters<
          typeof verifyAuthenticationResponse
        >[0]['response'],
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: new URL(this.origin).hostname,
        requireUserVerification: true,
        credential: {
          id: key.id,
          publicKey: fromBase64url(key.public_key),
          counter: key.counter,
          transports: JSON.parse(key.transports),
        },
      });
    } catch {
      throw new AppError(401, 'INVALID_PASSKEY', 'unauthorized');
    }
    if (!verification.verified) throw new AppError(401, 'INVALID_PASSKEY', 'unauthorized');
    const owner = await this.owner(key.owner_id);
    if (owner.status !== 'active') throw new AppError(403, 'OWNER_DISABLED', 'forbidden');
    const token = randomToken();
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE passkeys SET counter=MAX(counter,?) WHERE id=? AND owner_id=?',
      ).bind(verification.authenticationInfo.newCounter, key.id, owner.id),
      this.env.DB.prepare(
        'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,created_at) VALUES(?,?,?,?,?)',
      ).bind(
        await sha256(token),
        owner.session_epoch,
        Date.now() + 604800000,
        owner.id,
        Date.now(),
      ),
    ]);
    return this.cookie(this.sessionCookie, token, 604800);
  }
  async completeAuthorization(request: AuthRequest, owner: Owner): Promise<string> {
    if (owner.status !== 'active') throw new AppError(403, 'OWNER_DISABLED', 'forbidden');
    const client = await this.helpers().lookupClient(request.clientId);
    const botId = crypto.randomUUID();
    await this.env.DB.prepare(
      'INSERT INTO bots(id,client_id,name,status,epoch,created_at,owner_id) VALUES(?,?,?,?,?,?,?)',
    )
      .bind(
        botId,
        request.clientId,
        (client?.clientName || 'MCP client').slice(0, 200),
        'active',
        owner.session_epoch,
        new Date().toISOString(),
        owner.id,
      )
      .run();
    try {
      const result = await this.helpers().completeAuthorization({
        request,
        userId: owner.id,
        metadata: { botId },
        scope: [
          FULL_SCOPE,
          ...(request.scope.includes(HEALTH_SCOPE) ? [HEALTH_SCOPE] : []),
          ...(request.scope.includes('offline_access') ? ['offline_access'] : []),
        ],
        props: { ownerId: owner.id, botId, epoch: owner.session_epoch } satisfies AuthProps,
      });
      return result.redirectTo;
    } catch (error) {
      await this.env.DB.prepare("UPDATE bots SET status='revoked' WHERE id=? AND owner_id=?")
        .bind(botId, owner.id)
        .run();
      throw error;
    }
  }
  async revokeBot(ownerId: string, botId: string): Promise<void> {
    await this.env.DB.prepare("UPDATE bots SET status='revoked' WHERE id=? AND owner_id=?")
      .bind(botId, ownerId)
      .run();
    let cursor: string | undefined;
    do {
      const page = await this.helpers().listUserGrants(ownerId, { cursor, limit: 100 });
      for (const grant of page.items)
        if ((grant.metadata as { botId?: string })?.botId === botId)
          await this.helpers().revokeGrant(grant.id, ownerId);
      cursor = page.cursor;
    } while (cursor);
  }
}
