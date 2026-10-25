import { FULL_SCOPE, type AuthService } from '../auth';
import { AppError } from '../errors';
import type { Actor, AuthProps, Env } from '../types';

export async function handleSync(request: Request, env: Env, auth: AuthService): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== auth.origin) throw new AppError(403, 'INVALID_ORIGIN', 'forbidden');
  const actor = await syncActor(request, env, auth);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    throw new AppError(426, 'UPGRADE_REQUIRED', 'syncUpgradeRequired');
  const url = new URL(request.url);
  url.pathname = `/${actor.ownerId}`;
  url.search = '';
  const headers = new Headers(request.headers);
  if (!headers.get('sec-websocket-key')) headers.set('sec-websocket-key', crypto.randomUUID());
  const stub = env.FITNESS_SYNC.get(env.FITNESS_SYNC.idFromName(actor.ownerId));
  return stub.fetch(new Request(url, { method: 'GET', headers }));
}

async function syncActor(request: Request, env: Env, auth: AuthService): Promise<Actor> {
  const header = request.headers.get('Authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    const token = await auth.authorizationServer.validateToken<AuthProps>(
      auth.origin,
      header.slice(header.indexOf(' ') + 1).trim(),
      env,
    );
    if (!token) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'unauthorized');
    if (!token.scope.includes(FULL_SCOPE)) throw new AppError(403, 'FORBIDDEN', 'forbidden');
    return auth.botActor(token.props, request, token.scope);
  }
  const session = await auth.session(request);
  if (!session) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'unauthorized');
  return session.actor;
}
