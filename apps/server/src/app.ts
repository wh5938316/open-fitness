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
import { OpenFoodFacts } from './adapters/open-food-facts';
import { AuthService, FULL_SCOPE, cookies, requireOrigin, safeReturn } from './auth';
import { FitnessService } from './domain/service';
import { AppError } from './errors';
import { resolveLocale, t } from './i18n';
import { cleanupMedia, MediaService } from './media';
import { handleMcp } from './mcp';
import type { Actor, AuthProps, Env } from './types';
import { adminPage, consentPage, loginPage } from './web/pages';
import { sha256 } from './crypto';

function createServices(env: Env, actor: Actor, origin: string) {
  const service = new FitnessService(
    new D1Repository(env.DB),
    actor,
    new OpenFoodFacts(
      new KVCache(env.CACHE),
      env.OFF_USER_AGENT ?? 'OpenFitness/0.1 (self-hosted)',
    ),
  );
  const media = new MediaService(service, env, new R2ObjectStore(env.MEDIA), origin);
  media.register();
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
        const actor = await auth.botActor(ctx.props, request);
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
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
    const owner = await auth.owner();
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
  app.get('/README.md', (c) => env.ASSETS.fetch(new Request(auth.origin + '/README.md')));
  app.get('/openapi.json', (c) => {
    const { service } = createServices(
      env,
      { ownerId: 'owner', id: 'schema', kind: 'owner', locale: 'en', timeZone: 'America/New_York' },
      auth.origin,
    );
    return c.json(openApi(service, auth.origin));
  });
  app.get('/', async (c) =>
    c.redirect(
      (await auth.session(c.req.raw))
        ? '/admin'
        : (await auth.owner()).setup_completed
          ? '/sign-in'
          : '/setup',
    ),
  );
  app.get('/setup', async (c) => {
    if ((await auth.owner()).setup_completed) return c.redirect('/sign-in');
    return c.html(loginPage(await locale(c.req.raw), true, safeReturn(c.req.query('returnTo'))));
  });
  app.get('/sign-in', async (c) => {
    const returnTo = safeReturn(c.req.query('returnTo'));
    if (await auth.session(c.req.raw)) return c.redirect(returnTo);
    return c.html(
      loginPage(await locale(c.req.raw), !(await auth.owner()).setup_completed, returnTo),
    );
  });
  app.post('/language', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    const form = await c.req.parseBody();
    if (form.locale !== 'en' && form.locale !== 'zh-CN') throw new AppError(422, 'INVALID_LOCALE');
    c.header('Set-Cookie', auth.cookie('of_locale', form.locale, 31536000));
    if (await auth.session(c.req.raw))
      await env.DB.prepare("UPDATE owners SET locale=? WHERE id='owner'").bind(form.locale).run();
    return c.redirect(safeReturn(String(form.returnTo ?? '/admin')), 303);
  });
  app.post('/auth/passkeys/registration-options', async (c) => {
    const result = await auth.registrationOptions(c.req.raw, await c.req.json());
    c.header('Set-Cookie', result.cookie);
    return c.json({ data: result.options });
  });
  app.post('/auth/passkeys/register', async (c) => {
    const cookie = await auth.register(c.req.raw, await c.req.json());
    c.header('Set-Cookie', cookie);
    return c.json({ data: { authenticated: true } });
  });
  app.post('/auth/passkeys/authentication-options', async (c) => {
    const result = await auth.authenticationOptions(c.req.raw);
    c.header('Set-Cookie', result.cookie);
    return c.json({ data: result.options });
  });
  app.post('/auth/passkeys/authenticate', async (c) => {
    const input = await c.req.json();
    c.header('Set-Cookie', await auth.authenticate(c.req.raw, input?.response));
    return c.json({ data: { authenticated: true } });
  });
  app.post('/auth/logout', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    const session = await auth.session(c.req.raw);
    if (session)
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.tokenHash).run();
    c.header('Set-Cookie', auth.cookie(auth.sessionCookie, '', 0));
    return c.redirect('/sign-in', 303);
  });
  app.get('/admin', async (c) => {
    const session = await auth.session(c.req.raw);
    if (!session) return c.redirect('/sign-in?returnTo=%2Fadmin');
    const bots = await env.DB.prepare(
      "SELECT id,name,created_at FROM bots WHERE status='active' ORDER BY created_at DESC",
    ).all<{ id: string; name: string; created_at: string }>();
    return c.html(adminPage(await locale(c.req.raw), bots.results, session.owner.time_zone));
  });
  app.post('/admin/bots/:id/revoke', async (c) => {
    requireOrigin(c.req.raw, auth.origin);
    if (!(await auth.session(c.req.raw)))
      throw new AppError(401, 'SESSION_REQUIRED', 'unauthorized');
    await auth.revokeBot(c.req.param('id'));
    return c.redirect('/admin', 303);
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
    if (!(await auth.session(c.req.raw)))
      throw new AppError(401, 'SESSION_REQUIRED', 'unauthorized');
    const form = await c.req.parseBody();
    if (typeof form.handle !== 'string' || (form.decision !== 'allow' && form.decision !== 'deny'))
      throw new AppError(422, 'INVALID_CONSENT');
    try {
      await env.DB.prepare('INSERT INTO consent_claims VALUES(?,?)')
        .bind(await sha256(form.handle), Date.now() + 1200000)
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
    const location = await auth.completeAuthorization(approved.request);
    approved.headers.set('Location', location);
    return new Response(null, { status: 303, headers: approved.headers });
  });
  app.put('/uploads/:token', async (c) => {
    const actor = auth.ownerActor(await auth.owner(), c.req.raw);
    actor.id = 'upload-capability';
    const { media } = createServices(env, actor, auth.origin);
    return c.json({ data: await media.upload(c.req.raw, c.req.param('token')) });
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
  const cursor = await env.CACHE.get('maintenance:oauth-cursor');
  const result = await new AuthService(env)
    .helpers()
    .purgeExpiredData({ ...(cursor ? { cursor } : {}) });
  if (result.cursor) await env.CACHE.put('maintenance:oauth-cursor', result.cursor);
  else await env.CACHE.delete('maintenance:oauth-cursor');
}
