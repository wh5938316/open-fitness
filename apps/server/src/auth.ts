import {
  OAuthAuthorizationServer,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { ClerkIdentityVerifier } from './adapters/clerk';
import { randomToken, sha256 } from './crypto';
import { AppError } from './errors';
import { resolveLocale } from './i18n';
import type {
  Actor,
  AuthProps,
  Env,
  ExternalIdentityVerifier,
  IdentityProvider,
  Owner,
  OwnerSession,
} from './types';

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
const clerkSessionSchema = z.object({ returnTo: z.string().max(2000).optional() });
export function clerkFrontendOrigin(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export function clerkPublishableKey(env: Env): string | null {
  const key = env.CLERK_PUBLISHABLE_KEY?.trim();
  if (!key || !clerkFrontendOrigin(env.CLERK_FRONTEND_API)) return null;
  return key;
}
export function contentSecurityPolicy(env: Env, clerkDocument: boolean): string {
  const strict =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  const frontend = clerkFrontendOrigin(env.CLERK_FRONTEND_API);
  if (!clerkDocument || !frontend) return strict;
  return [
    "default-src 'self'",
    `script-src 'self' ${frontend} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://img.clerk.com",
    `connect-src 'self' ${frontend} https://clerk-telemetry.com https://*.clerk-telemetry.com https://*.protect.clerk.com:*`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    `form-action 'self' ${frontend}`,
  ].join('; ');
}
export class AuthService implements IdentityProvider {
  readonly origin: string;
  readonly sessionCookie: string;
  readonly authorizationServer: OAuthAuthorizationServer<Env>;
  readonly identities: ExternalIdentityVerifier;
  constructor(
    public env: Env,
    identities?: ExternalIdentityVerifier,
  ) {
    this.origin = baseUrl(env);
    this.identities = identities ?? new ClerkIdentityVerifier(env, this.origin);
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
  async exchangeClerkSession(
    request: Request,
    raw: unknown,
  ): Promise<{ cookie: string; returnTo: string }> {
    requireOrigin(request, this.origin);
    await this.rateLimit(request);
    const header = request.headers.get('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token) throw new AppError(401, 'INVALID_CLERK_TOKEN', 'unauthorized');
    const input = parseAuthInput(clerkSessionSchema, raw);
    if (input.returnTo !== undefined && safeReturn(input.returnTo) !== input.returnTo)
      throw new AppError(400, 'INVALID_RETURN_TO', 'invalidInput');
    const identity = await this.identities.verifySessionToken(token);
    let owner = await this.env.DB.prepare(
      `SELECT ${OWNER_COLUMNS} FROM owners WHERE clerk_user_id=?`,
    )
      .bind(identity.subject)
      .first<Owner>();
    if (!owner) {
      if (this.env.CLERK_AUTO_PROVISION !== 'true')
        throw new AppError(403, 'ACCOUNT_NOT_PROVISIONED', 'accountNotProvisioned');
      owner = await this.provisionOwner(identity.subject);
    }
    if (owner.status !== 'active') throw new AppError(403, 'OWNER_DISABLED', 'forbidden');
    const sessionToken = randomToken();
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare(
        'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,clerk_session_id,created_at) VALUES(?,?,?,?,?,?)',
      ).bind(
        await sha256(sessionToken),
        owner.session_epoch,
        now + 604800000,
        owner.id,
        identity.sessionId,
        now,
      ),
      this.env.DB.prepare(
        'INSERT INTO audit_events(id,actor_id,operation,target_id,created_at,owner_id) VALUES(?,?,?,?,?,?)',
      ).bind(
        crypto.randomUUID(),
        owner.id,
        'clerk_sign_in',
        identity.sessionId,
        new Date(now).toISOString(),
        owner.id,
      ),
    ]);
    return {
      cookie: this.cookie(this.sessionCookie, sessionToken, 604800),
      returnTo: safeReturn(input.returnTo),
    };
  }
  private async provisionOwner(subject: string): Promise<Owner> {
    let profile: { email: string | null };
    try {
      profile = await this.identities.fetchProfile(subject);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'CLERK_PROFILE_UNAVAILABLE', 'internalError');
    }
    const timeZone = this.env.DEFAULT_TIME_ZONE || 'America/New_York';
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format();
    } catch {
      throw new AppError(503, 'INVALID_DEFAULT_TIME_ZONE', 'internalError');
    }
    const created = await this.env.DB.prepare(
      `INSERT INTO owners(id,clerk_user_id,email,status,created_at,time_zone,setup_completed)
       VALUES(?,?,?,'active',?,?,1)
       ON CONFLICT(clerk_user_id) DO NOTHING
       RETURNING ${OWNER_COLUMNS}`,
    )
      .bind(crypto.randomUUID(), subject, profile.email, Date.now(), timeZone)
      .first<Owner>();
    if (created) return created;
    const existing = await this.env.DB.prepare(
      `SELECT ${OWNER_COLUMNS} FROM owners WHERE clerk_user_id=?`,
    )
      .bind(subject)
      .first<Owner>();
    if (!existing) throw new AppError(503, 'ACCOUNT_NOT_PROVISIONED', 'internalError');
    return existing;
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
