import { FULL_SCOPE, type AuthService } from '../auth';
import { AppError } from '../errors';
import type { Actor, AuthProps, Env } from '../types';

const SOCKET_CAP_MS = 60 * 60 * 1000;

export interface SyncAccess {
  actor: Actor;
  /** Absolute expiry in milliseconds, capped at one hour from accept time. */
  expiresAt: number;
}

export async function handleSync(request: Request, env: Env, auth: AuthService): Promise<Response> {
  const access = await syncActor(request, env, auth);
  return upgradeSync(request, env.FITNESS_SYNC, access.actor.ownerId);
}

export async function handleSyncEvents(
  request: Request,
  env: Env,
  auth: AuthService,
): Promise<Response> {
  const access = await syncActor(request, env, auth);
  const url = socketUrl(request, access.actor.ownerId);
  url.searchParams.set('expiresAt', String(access.expiresAt));
  const headers = socketHeaders(request);
  const stub = env.FITNESS_EVENTS.get(env.FITNESS_EVENTS.idFromName(access.actor.ownerId));
  return stub.fetch(new Request(url, { method: 'GET', headers }));
}

export async function syncActor(
  request: Request,
  env: Env,
  auth: AuthService,
): Promise<SyncAccess> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== auth.origin) throw new AppError(403, 'INVALID_ORIGIN', 'forbidden');
  const cap = Date.now() + SOCKET_CAP_MS;
  const header = request.headers.get('Authorization');
  let access: SyncAccess;
  if (header?.toLowerCase().startsWith('bearer ')) {
    const token = await auth.authorizationServer.validateToken<AuthProps>(
      auth.origin,
      header.slice(header.indexOf(' ') + 1).trim(),
      env,
    );
    if (!token) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'unauthorized');
    if (!token.scope.includes(FULL_SCOPE)) throw new AppError(403, 'FORBIDDEN', 'forbidden');
    access = {
      actor: await auth.botActor(token.props, request, token.scope),
      expiresAt: Math.min(epochMs(token.expiresAt), cap),
    };
  } else {
    const session = await auth.session(request);
    if (!session) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'unauthorized');
    access = { actor: session.actor, expiresAt: Math.min(session.expiresAt, cap) };
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    throw new AppError(426, 'UPGRADE_REQUIRED', 'syncUpgradeRequired');
  return access;
}

/** Token expiry is seconds since the epoch. Session expiry is already milliseconds. */
function epochMs(value: number): number {
  return value > 10_000_000_000 ? value : value * 1000;
}

function socketUrl(request: Request, ownerId: string): URL {
  const url = new URL(request.url);
  url.pathname = `/${ownerId}`;
  url.search = '';
  return url;
}

function socketHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  if (!headers.get('sec-websocket-key')) headers.set('sec-websocket-key', crypto.randomUUID());
  return headers;
}

function upgradeSync(
  request: Request,
  namespace: Env['FITNESS_SYNC'],
  ownerId: string,
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(ownerId));
  return stub.fetch(
    new Request(socketUrl(request, ownerId), { method: 'GET', headers: socketHeaders(request) }),
  );
}
