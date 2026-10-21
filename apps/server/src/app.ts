import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  AuthorizationError,
  CimdFetchError,
  OAuthResourceServer,
  insufficientScope,
} from '@cloudflare/workers-oauth-provider';
import { D1Repository, KVCache, R2ObjectStore } from './adapters/cloudflare';
import { createFoodCatalog } from './adapters/cached-food-catalog';
import { D1FoodCatalogStore } from './adapters/d1-food-catalog';
import { D1HealthSyncStore } from './adapters/cloudflare-health';
import { registerHealthOperations } from './domain/health';
import {
  AuthService,
  FULL_SCOPE,
  clerkAccountPortalUrl,
  clerkPublishableKey,
  contentSecurityPolicy,
  cookies,
  requireOrigin,
  safeReturn,
} from './auth';
import { FitnessService } from './domain/service';
import { AppError, notFound } from './errors';
import { resolveLocale, t } from './i18n';
import { cleanupMedia, MediaService } from './media';
import { handleMcp } from './mcp';
import type { Actor, AuthProps, Env } from './types';
import { handleClerkWebhook } from './clerk-webhook';
import { signClerkTestToken } from './test-clerk-jwt';
import {
  accountPage,
  adminPage,
  clerkCompletePage,
  clerkSignOutPage,
  consentPage,
  loginPage,
} from './web/pages';
import { sha256 } from './crypto';
import { requireBarcode } from './domain/barcode';
import { foodSchema } from './domain/schemas';

function createServices(env: Env, actor: Actor, origin: string) {
  const service = new FitnessService(new D1Repository(env.DB), actor, createFoodCatalog(env));
  const media = new MediaService(service, env, new R2ObjectStore(env.MEDIA), origin);
  media.register();
  registerHealthOperations(service, new D1HealthSyncStore(env.DB), new KVCache(env.CACHE));
  return { service, media };
}
export function openApi(service: FitnessService, origin: string): object {
  const paths: Record<string, any> = {};
  for (const operation of service.operations.values()) {
    const schema = z.toJSONSchema(operation.schema, { io: 'input', unrepresentable: 'any' }) as any;
    const pathKeys = [...operation.path.matchAll(/:([\w]+)/g)].map((match) => match[1]!);
    const path = '/api/v1' + operation.path.replace(/:([\w]+)/g, '{$1}');
    const parameters = pathKeys.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: schema.properties?.[name] ?? { type: 'string' },
    }));
    const bodyProperties = Object.fromEntries(
      Object.entries(schema.properties ?? {}).filter(([key]) => !pathKeys.includes(key)),
    );
    if (operation.method === 'GET')
      parameters.push(
        ...Object.entries(bodyProperties).map(([name, field]) => ({
          name,
          in: 'query',
          required: Boolean(schema.required?.includes(name)),
          schema: field as any,
        })),
      );
    const bodySchema = {
      ...schema,
      properties: bodyProperties,
      required: (schema.required ?? []).filter((name: string) => !pathKeys.includes(name)),
    };
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = {
      operationId: operation.name,
      description: operation.description,
      parameters,
      ...(operation.method !== 'GET'
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: bodySchema } },
            },
          }
        : {}),
      responses: {
        '200': { description: 'The operation result in the data envelope.' },
        '401': { description: 'Authentication required.' },
        '409': { description: 'Version or idempotency conflict.' },
        '422': { description: 'Input or conversion information is invalid or incomplete.' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenFitness API',
      version: '0.1.0',
      description: 'Headless fitness operations shared by MCP agents and native clients.',
      license: { name: 'MIT' },
    },
    servers: [{ url: origin }],
    paths,
    security: [{ OAuth: [FULL_SCOPE] }],
    components: {
      securitySchemes: {
        OAuth: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: origin + '/authorize',
              tokenUrl: origin + '/oauth/token',
              scopes: { [FULL_SCOPE]: 'Full access to fitness business operations.' },
            },
          },
        },
      },
    },
  };
}
function businessApp(service: FitnessService, media: MediaService) {
  const app = new Hono();
  app.all('/mcp', (c) => handleMcp(c.req.raw, service));
  app.get('/api/v1/media/:id/content', (c) => media.content(c.req.param('id'), c.req.raw));
  for (const operation of service.operations.values()) {
    app.on(operation.method, '/api/v1' + operation.path, async (c) => {
      let input: Record<string, unknown>;
      if (operation.method === 'GET') {
        input = { ...c.req.query() };
        if ('limit' in input) input.limit = Number(input.limit);
        if (input.includeCatalog === 'true') input.includeCatalog = true;
        else if (input.includeCatalog === 'false') input.includeCatalog = false;
      } else {
        try {
          input = await c.req.json();
        } catch {
          throw new AppError(422, 'INVALID_JSON');
        }
      }
      const result = await service.execute(operation.name, { ...input, ...c.req.param() });
      return c.json({ data: result });
    });
  }
  app.onError((error, c) => {
    const app =
      error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', 'internalError');
    if (!(error instanceof AppError))
      console.error(
        JSON.stringify({
          event: 'business_request_failed',
          code: 'INTERNAL_ERROR',
          path: c.req.path,
        }),
      );
    return Response.json(
      {
        error: {
          code: app.code,
          message: t(service.actor.locale, app.messageKey),
          ...(app.details ? { details: app.details } : {}),
        },
      },
      { status: app.status },
    );
  });
  return app;
}

export function createApp(env: Env): Hono<{ Bindings: Env }> {
  const auth = new AuthService(env);
  const app = new Hono<{ Bindings: Env }>();
  const jsonLimit = bodyLimit({
    maxSize: 2097152,
    onError: () => {
      throw new AppError(413, 'REQUEST_TOO_LARGE');
    },
  });
  app.use('*', (c, next) => (c.req.path.startsWith('/uploads/') ? next() : jsonLimit(c, next)));
  const resource = new OAuthResourceServer<Env, AuthProps>({
    resourceMetadata: { resource: auth.origin, authorization_servers: [auth.origin] },
    requiredScopes: [FULL_SCOPE],
    validateToken: () => (resource, token) =>
      auth.authorizationServer.validateToken<AuthProps>(resource, token, env),
    handler: {
      async fetch(request, _env, ctx) {
        if (!ctx.auth.scope.includes(FULL_SCOPE)) return insufficientScope(ctx.auth, [FULL_SCOPE]);
        const actor = await auth.botActor(ctx.props, request, ctx.auth.scope);
        const { service, media } = createServices(env, actor, auth.origin);
        return businessApp(service, media).fetch(request);
      },
    },
  });
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Cache-Control', 'no-store');
    c.header(
      'Content-Security-Policy',
      contentSecurityPolicy(
        env,
        ['/auth/clerk/complete', '/auth/clerk/sign-out'].includes(c.req.path),
      ),
    );
    const length = Number(c.req.header('Content-Length') || 0);
    if (length > 2097152 && !c.req.path.startsWith('/uploads/'))
      throw new AppError(413, 'REQUEST_TOO_LARGE');
    await next();
    console.info(
      JSON.stringify({
        event: 'http_request',
        requestId,
        method: c.req.method,
        path: c.req.path.startsWith('/uploads/') ? '/uploads/:token' : c.req.path,
        status: c.res.status,
      }),
    );
  });
  const locale = async (request: Request) => {
    const session = await auth.session(request);
    const owner = session?.owner ?? (await auth.owner());
    return resolveLocale(
      cookies(request).of_locale ?? owner.locale,
      request.headers.get('Accept-Language') ?? '',
    );
  };
  app.get('/healthz', async (c) => {
    await env.DB.prepare('SELECT 1').first();
    return c.json({ status: 'ok', service: 'OpenFitness' });
  });
  app.get('/auth.js', (c) => env.ASSETS.fetch(c.req.raw));
  app.get('/:chunk{auth-[A-Za-z0-9]+\\.js}', (c) => env.ASSETS.fetch(c.req.raw));
  app.get('/README.md', (c) => env.ASSETS.fetch(new Request(auth.origin + '/README.md')));
  app.get('/openapi.json', (c) => {
    const { service } = createServices(
      env,
      {
        ownerId: 'schema',
        id: 'schema',
        kind: 'owner',
        locale: 'en',
        timeZone: 'America/New_York',
      },
      auth.origin,
    );
    return c.json(openApi(service, auth.origin));
  });
  app.get('/', async (c) => c.redirect((await auth.session(c.req.raw)) ? '/admin' : '/sign-in'));
  app.get('/setup', (c) => c.redirect('/sign-in'));
  app.get('/sign-in', async (c) => {
    const returnTo = safeReturn(c.req.query('returnTo'));
    if (await auth.session(c.req.raw)) return c.redirect(returnTo);
    const complete = new URL('/auth/clerk/complete', auth.origin);
    complete.searchParams.set('returnTo', returnTo);
    const portal = clerkPublishableKey(env)
      ? clerkAccountPortalUrl(env.CLERK_FRONTEND_API, 'sign-in', complete.href)
      : null;
    if (!portal) return c.html(loginPage(await locale(c.req.raw), returnTo));
    return c.redirect(portal);
  });
  app.get('/auth/clerk/complete', async (c) => {
    const key = clerkPublishableKey(env);
    if (!key) return c.redirect('/sign-in');
    return c.html(
      clerkCompletePage(await locale(c.req.raw), safeReturn(c.req.query('returnTo')), key),
    );
  });
  app.get('/auth/clerk/sign-out', async (c) => {
    const key = clerkPublishableKey(env);
    if (!key) return c.redirect('/sign-in');
    return c.html(clerkSignOutPage(await locale(c.req.raw), key));
  });
  app.post('/auth/clerk/session', async (c) => {
    let body: unknown = {};
    try {
      if (c.req.header('content-length') !== '0') body = await c.req.json();
    } catch {
      throw new AppError(422, 'INVALID_JSON');
    }
    const result = await auth.exchangeClerkSession(c.req.raw, body);
    c.header('Set-Cookie', result.cookie);
    return c.json({ data: { returnTo: result.returnTo } });
  });
  app.post('/__test/clerk-token', async (c) => {
    const host = new URL(c.req.url).hostname;
    if (env.CLERK_TEST_MODE !== '1' || (host !== 'localhost' && host !== '127.0.0.1'))
      throw notFound();
    if (!env.CLERK_TEST_PRIVATE_KEY)
      throw new AppError(503, 'CLERK_NOT_CONFIGURED', 'internalError');
    let body: { sub?: string; sid?: string; azp?: string; exp?: number } = {};
    try {
      if (c.req.header('content-length') !== '0') body = await c.req.json();
    } catch {
      throw new AppError(422, 'INVALID_JSON');
    }
    const now = Math.floor(Date.now() / 1000);
    const sub = typeof body.sub === 'string' && body.sub ? body.sub : 'user_test';
    const claims: Record<string, unknown> = {
      sub,
      azp: typeof body.azp === 'string' ? body.azp : auth.origin,
      iat: now,
      nbf: now,
      exp: typeof body.exp === 'number' ? body.exp : now + 60,
    };
    if (body.sid !== '') claims.sid = typeof body.sid === 'string' ? body.sid : 'sess_test';
    return c.json({
      data: { token: await signClerkTestToken(env.CLERK_TEST_PRIVATE_KEY, claims) },
    });
  });
  app.put('/__test/food-catalog', async (c) => {
    const host = new URL(c.req.url).hostname;
    if (env.CLERK_TEST_MODE !== '1' || (host !== 'localhost' && host !== '127.0.0.1'))
      throw notFound();
    let body: {
      forceStatus?: string | null;
      fixture?: { code?: string; name?: string; kcal?: number } | null;
      product?: { code?: string; brands?: string | null; fetchedAt?: string; food?: unknown };
    } = {};
    try {
      body = await c.req.json();
    } catch {
      throw new AppError(422, 'INVALID_JSON');
    }
    const cache = new KVCache(env.CACHE);
    if (body.forceStatus === null) await env.CACHE.delete('off:test:force-status');
    else if (
      body.forceStatus === '503' ||
      body.forceStatus === '429' ||
      body.forceStatus === 'fixture'
    )
      await cache.put('off:test:force-status', body.forceStatus, 120);
    else if (body.forceStatus !== undefined)
      throw new AppError(422, 'INVALID_INPUT', 'invalidInput');
    if (body.fixture === null) await env.CACHE.delete('off:test:fixture');
    else if (body.fixture) await cache.put('off:test:fixture', body.fixture, 120);
    if (body.product) {
      const food = foodSchema.parse(body.product.food);
      const code = requireBarcode(body.product.code ?? food.barcode ?? '');
      await new D1FoodCatalogStore(env.DB).upsert({
        code,
        productName: food.name,
        brands: body.product.brands ?? null,
        food: { ...food, barcode: code },
        upstreamModifiedAt: food.source.upstreamModifiedAt ?? null,
        fetchedAt: body.product.fetchedAt ?? new Date().toISOString(),
      });
    }
    return c.json({ data: { ok: true } });
  });
  app.post('/language', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    const form = await c.req.parseBody();
    if (form.locale !== 'en' && form.locale !== 'zh-CN') throw new AppError(422, 'INVALID_LOCALE');
    c.header('Set-Cookie', auth.cookie('of_locale', form.locale, 31536000));
    const session = await auth.session(c.req.raw);
    if (session)
      await env.DB.prepare('UPDATE owners SET locale=? WHERE id=?')
        .bind(form.locale, session.owner.id)
        .run();
    return c.redirect(safeReturn(String(form.returnTo ?? '/admin')), 303);
  });
  app.post('/auth/logout', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    const session = await auth.session(c.req.raw);
    if (session)
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.tokenHash).run();
    c.header('Set-Cookie', auth.cookie(auth.sessionCookie, '', 0));
    return c.redirect(clerkPublishableKey(env) ? '/auth/clerk/sign-out' : '/sign-in', 303);
  });
  app.get('/admin', async (c) => {
    const session = await auth.session(c.req.raw);
    if (!session) return c.redirect('/sign-in?returnTo=%2Fadmin');
    const bots = await env.DB.prepare(
      "SELECT id,name,created_at FROM bots WHERE owner_id=? AND status='active' ORDER BY created_at DESC",
    )
      .bind(session.owner.id)
      .all<{ id: string; name: string; created_at: string }>();
    return c.html(adminPage(await locale(c.req.raw), bots.results, session.owner.time_zone));
  });
  app.get('/account', async (c) => {
    const session = await auth.session(c.req.raw);
    if (!session) return c.redirect('/sign-in?returnTo=%2Faccount');
    const bots = await env.DB.prepare(
      "SELECT id,name,created_at FROM bots WHERE owner_id=? AND status='active' ORDER BY created_at DESC",
    )
      .bind(session.owner.id)
      .all<{ id: string; name: string; created_at: string }>();
    return c.html(
      accountPage(
        await locale(c.req.raw),
        bots.results,
        session.owner.time_zone,
        clerkAccountPortalUrl(env.CLERK_FRONTEND_API, 'user', auth.origin + '/account') ??
          undefined,
      ),
    );
  });
  app.post('/account/time-zone', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    const session = await auth.session(c.req.raw);
    if (!session) throw new AppError(401, 'SESSION_REQUIRED', 'unauthorized');
    const form = await c.req.parseBody();
    const timeZone = typeof form.timeZone === 'string' ? form.timeZone.trim() : '';
    if (!timeZone || timeZone.length > 100) throw new AppError(422, 'INVALID_TIME_ZONE');
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format();
    } catch {
      throw new AppError(422, 'INVALID_TIME_ZONE');
    }
    await env.DB.prepare('UPDATE owners SET time_zone=? WHERE id=?')
      .bind(timeZone, session.owner.id)
      .run();
    return c.redirect('/account', 303);
  });
  app.post('/account/sessions/revoke', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    const session = await auth.session(c.req.raw);
    if (!session) throw new AppError(401, 'SESSION_REQUIRED', 'unauthorized');
    await env.DB.prepare('UPDATE owners SET session_epoch=session_epoch+1 WHERE id=?')
      .bind(session.owner.id)
      .run();
    c.header('Set-Cookie', auth.cookie(auth.sessionCookie, '', 0));
    return c.redirect(clerkPublishableKey(env) ? '/auth/clerk/sign-out' : '/sign-in', 303);
  });
  app.post('/webhooks/clerk', (c) => handleClerkWebhook(c.req.raw, env));
  app.post('/admin/bots/:id/revoke', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    const session = await auth.session(c.req.raw);
    if (!session) throw new AppError(401, 'SESSION_REQUIRED', 'unauthorized');
    await auth.revokeBot(session.owner.id, c.req.param('id'));
    const referer = c.req.header('Referer');
    let next = '/admin';
    if (referer) {
      try {
        const path = new URL(referer).pathname;
        if (path === '/account' || path === '/admin') next = path;
      } catch {
        next = '/admin';
      }
    }
    return c.redirect(next, 303);
  });
  app.get('/authorize', async (c) => {
    const parsed = await auth.helpers().parseAuthRequest(c.req.raw);
    if (!(await auth.session(c.req.raw)))
      return c.redirect(
        '/sign-in?returnTo=' + encodeURIComponent(c.req.path + new URL(c.req.url).search),
      );
    const description = await auth.helpers().describeConsent(parsed);
    const transaction = await auth.helpers().beginConsent(parsed);
    return new Response(
      consentPage(
        await locale(c.req.raw),
        { ...description, handle: transaction.handle },
        c.req.path + new URL(c.req.url).search,
      ),
      { headers: withHtml(transaction.headers) },
    );
  });
  app.post('/authorize', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    const session = await auth.session(c.req.raw);
    if (!session) throw new AppError(401, 'SESSION_REQUIRED', 'unauthorized');
    const form = await c.req.parseBody();
    if (typeof form.handle !== 'string' || (form.decision !== 'allow' && form.decision !== 'deny'))
      throw new AppError(422, 'INVALID_CONSENT');
    try {
      await env.DB.prepare(
        'INSERT INTO consent_claims(handle_hash,expires_at,owner_id) VALUES(?,?,?)',
      )
        .bind(await sha256(form.handle), Date.now() + 1200000, session.owner.id)
        .run();
    } catch (error) {
      if (String(error).includes('UNIQUE constraint'))
        throw new AppError(400, 'CONSENT_ALREADY_USED');
      throw error;
    }
    if (form.decision === 'deny') {
      const result = await auth.helpers().denyConsent(c.req.raw, form.handle);
      return new Response(null, { status: 303, headers: result.headers });
    }
    const approved = await auth.helpers().approveConsent(c.req.raw, form.handle);
    const location = await auth.completeAuthorization(approved.request, session.owner);
    approved.headers.set('Location', location);
    return new Response(null, { status: 303, headers: approved.headers });
  });
  app.put('/uploads/:token', async (c) => {
    const token = c.req.param('token');
    const ticket = await env.DB.prepare(
      'SELECT owner_id FROM upload_tickets WHERE token_hash=? AND used_at IS NULL AND expires_at>?',
    )
      .bind(await sha256(token), Date.now())
      .first<{ owner_id: string }>();
    if (!ticket) throw new AppError(410, 'UPLOAD_EXPIRED', 'uploadExpired');
    const uploadSession = await auth.session(c.req.raw);
    if (uploadSession && uploadSession.owner.id !== ticket.owner_id) throw notFound();
    const owner = await auth.owner(ticket.owner_id);
    if (owner.status !== 'active') throw new AppError(401, 'CONNECTION_REVOKED', 'unauthorized');
    const actor = auth.ownerActor(owner, c.req.raw);
    actor.id = 'upload-capability';
    const { media } = createServices(env, actor, auth.origin);
    return c.json({ data: await media.upload(c.req.raw, token) });
  });
  app.all('/.well-known/oauth-protected-resource', (c) =>
    resource.fetch(c.req.raw, env, c.executionCtx as ExecutionContext),
  );
  app.all('/.well-known/*', (c) =>
    auth.authorizationServer.fetch(c.req.raw, env, c.executionCtx as ExecutionContext),
  );
  app.all('/oauth/*', async (c) => {
    if (c.req.path === '/oauth/register') await auth.rateLimit(c.req.raw);
    return auth.authorizationServer.fetch(c.req.raw, env, c.executionCtx as ExecutionContext);
  });
  const protectedHandler = async (request: Request, ctx: ExecutionContext): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const allowed = [
      auth.origin,
      ...(env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ];
    if (origin && !allowed.includes(origin)) throw new AppError(403, 'INVALID_ORIGIN', 'forbidden');
    if (request.method === 'OPTIONS')
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || auth.origin,
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers':
            'Authorization,Content-Type,Accept,MCP-Protocol-Version,Mcp-Method,Mcp-Name',
          'Access-Control-Expose-Headers': 'WWW-Authenticate,MCP-Protocol-Version',
        },
      });
    const session = new URL(request.url).pathname.startsWith('/api/v1/')
      ? await auth.session(request)
      : null;
    if (session && !request.headers.has('Authorization')) {
      if (!['GET', 'HEAD'].includes(request.method)) requireOrigin(request, auth.origin);
      const { service, media } = createServices(env, session.actor, auth.origin);
      return businessApp(service, media).fetch(request);
    }
    const response = await resource.fetch(request, env, ctx);
    if (origin) {
      const copy = new Response(response.body, response);
      copy.headers.set('Access-Control-Allow-Origin', origin);
      copy.headers.append('Vary', 'Origin');
      return copy;
    }
    return response;
  };
  app.all('/mcp', (c) => protectedHandler(c.req.raw, c.executionCtx as ExecutionContext));
  app.all('/api/v1/*', (c) => protectedHandler(c.req.raw, c.executionCtx as ExecutionContext));
  app.onError(async (error, c) => {
    if (error instanceof AuthorizationError && error.redirectTo)
      return c.redirect(error.redirectTo, 303);
    const app =
      error instanceof AppError
        ? error
        : error instanceof AuthorizationError
          ? new AppError(400, 'INVALID_AUTHORIZATION_REQUEST')
          : error instanceof CimdFetchError
            ? new AppError(400, 'CLIENT_METADATA_UNAVAILABLE', 'clientUnverified')
            : new AppError(
                error instanceof SyntaxError ? 422 : 500,
                error instanceof SyntaxError ? 'INVALID_JSON' : 'INTERNAL_ERROR',
                error instanceof SyntaxError ? 'invalidInput' : 'internalError',
              );
    if (!(error instanceof AppError) && !(error instanceof SyntaxError))
      console.error(JSON.stringify({ event: 'request_failed', code: app.code, path: c.req.path }));
    let lang: 'en' | 'zh-CN' = resolveLocale(null, c.req.header('Accept-Language'));
    try {
      lang = await locale(c.req.raw);
    } catch {}
    return Response.json(
      {
        error: {
          code: app.code,
          message: t(lang, app.messageKey),
          ...(app.details ? { details: app.details } : {}),
        },
      },
      { status: app.status },
    );
  });
  return app;
}
function withHtml(headers: Headers): Headers {
  const result = new Headers(headers);
  result.set('Content-Type', 'text/html; charset=utf-8');
  result.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return result;
}
export async function scheduled(env: Env): Promise<void> {
  await cleanupMedia(env);
  try {
    await createFoodCatalog(env).refreshStale();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'catalog_refresh_failed',
        code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
      }),
    );
  }
  const cursor = await env.CACHE.get('maintenance:oauth-cursor');
  const result = await new AuthService(env)
    .helpers()
    .purgeExpiredData({ ...(cursor ? { cursor } : {}) });
  if (result.cursor) await env.CACHE.put('maintenance:oauth-cursor', result.cursor);
  else await env.CACHE.delete('maintenance:oauth-cursor');
}
