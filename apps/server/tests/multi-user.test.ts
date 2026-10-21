import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app';
import { AuthService } from '../src/auth';
import { ClerkIdentityVerifier } from '../src/adapters/clerk';
import { base64url, randomToken, sha256 } from '../src/crypto';
import {
  generateClerkTestKeys,
  signClerkTestToken,
  type ClerkTestKeys,
} from '../src/test-clerk-jwt';
import type { Env } from '../src/types';

const origin = 'http://localhost:8787';
const webhookSecret = 'whsec_' + btoa('012345678901234567890123');
let keys: ClerkTestKeys;

beforeAll(async () => {
  keys = await generateClerkTestKeys();
});

function withEnv(extra: Partial<Env>): Env {
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(extra, prop))
        return extra[prop as keyof Env];
      return Reflect.get(target, prop, receiver);
    },
  }) as Env;
}
function runtime(): Env {
  return withEnv({
    CLERK_JWT_KEY: keys.publicPem,
    CLERK_AUTO_PROVISION: 'true',
    CLERK_WEBHOOK_SECRET: webhookSecret,
    CLERK_FRONTEND_API: 'https://clerk.example.test',
    CLERK_PUBLISHABLE_KEY: 'pk_test_example',
  });
}
function authFor(email: string, bindings = runtime()): AuthService {
  const inner = new ClerkIdentityVerifier(bindings, origin);
  return new AuthService(bindings, {
    verifySessionToken: (token) => inner.verifySessionToken(token),
    fetchProfile: async () => ({ email }),
  });
}
async function clerkToken(sub: string, sid = 'sess_' + sub): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signClerkTestToken(keys.privatePem, {
    sub,
    sid,
    azp: origin,
    iat: now,
    nbf: now,
    exp: now + 60,
  });
}
async function signIn(
  sub: string,
  email: string,
  sid?: string,
): Promise<{
  cookie: string;
  ownerId: string;
  auth: AuthService;
}> {
  const bindings = runtime();
  const auth = authFor(email, bindings);
  const exchanged = await auth.exchangeClerkSession(
    new Request(origin + '/auth/clerk/session', {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: 'Bearer ' + (await clerkToken(sub, sid)),
      },
    }),
    {},
  );
  const cookie = exchanged.cookie.split(';')[0]!;
  const session = await auth.session(new Request(origin, { headers: { Cookie: cookie } }));
  if (!session) throw new Error('expected a session');
  return { cookie, ownerId: session.owner.id, auth };
}
async function request(path: string, init?: RequestInit): Promise<Response> {
  const bindings = runtime();
  const ctx = createExecutionContext();
  const response = await createApp(bindings).fetch(new Request(origin + path, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function api(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return request(path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function jsonOf(response: Response): Promise<any> {
  return response.json();
}
async function webhook(payload: unknown, id?: string, signature?: string): Promise<Response> {
  const deliveryId = id ?? crypto.randomUUID();
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(webhookSecret.slice('whsec_'.length)), (char) => char.charCodeAt(0)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${deliveryId}.${timestamp}.${body}`),
  );
  const signed = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return request('/webhooks/clerk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': deliveryId,
      'svix-timestamp': String(timestamp),
      'svix-signature': signature ?? `v1,${signed}`,
    },
    body,
  });
}
async function authorize(cookie: string, scope: string): Promise<string> {
  const verifier = randomToken();
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const registered = await request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Tenant ' + scope,
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(registered.status).toBe(201);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://client.example/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    resource: origin,
    state: 'tenant',
  });
  const page = await request('/authorize?' + query, { headers: { Cookie: cookie } });
  expect(page.status).toBe(200);
  const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)?.[1];
  const consent = [cookie]
    .concat(page.headers.getSetCookie().map((value) => value.split(';')[0]!))
    .join('; ');
  const approval = await request('/authorize', {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: consent,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ handle: handle!, decision: 'allow' }),
  });
  expect(approval.status).toBe(303);
  const location = new URL(approval.headers.get('Location')!);
  const traded = await request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: location.searchParams.get('code')!,
      redirect_uri: 'https://client.example/callback',
      code_verifier: verifier,
      resource: origin,
    }),
  });
  expect(traded.status).toBe(200);
  return ((await traded.json()) as { access_token: string }).access_token;
}

describe('multi-user isolation', () => {
  it('opens an account from the HTTP exchange in test mode without calling Clerk', async () => {
    const bindings = withEnv({
      CLERK_JWT_KEY: keys.publicPem,
      CLERK_TEST_PRIVATE_KEY: keys.privatePem,
      CLERK_TEST_MODE: '1',
      CLERK_AUTO_PROVISION: 'true',
    });
    const sub = 'user_http_' + crypto.randomUUID().replaceAll('-', '');
    const ctx = createExecutionContext();
    const minted = await createApp(bindings).fetch(
      new Request(origin + '/__test/clerk-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub, sid: 'sess_http' }),
      }),
      bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(minted.status).toBe(200);
    const token = ((await minted.json()) as { data: { token: string } }).data.token;
    const ctx2 = createExecutionContext();
    const exchanged = await createApp(bindings).fetch(
      new Request(origin + '/auth/clerk/session', {
        method: 'POST',
        headers: {
          Origin: origin,
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ returnTo: '/account' }),
      }),
      bindings,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(exchanged.status).toBe(200);
    const owner = await env.DB.prepare('SELECT email FROM owners WHERE clerk_user_id=?')
      .bind(sub)
      .first<{ email: string }>();
    expect(owner?.email).toBe(sub + '@example.test');
  });

  it('creates one owner when the same Clerk user signs in concurrently', async () => {
    const sub = 'user_' + crypto.randomUUID().replaceAll('-', '');
    const bindings = runtime();
    const auth = authFor('race@example.com', bindings);
    const requestFor = new Request(origin + '/auth/clerk/session', {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer ' + (await clerkToken(sub, 'sess_race')) },
    });
    const [first, second] = await Promise.all([
      auth.exchangeClerkSession(requestFor.clone() as never, {}),
      auth.exchangeClerkSession(requestFor.clone() as never, {}),
    ]);
    expect(first.cookie).toContain('of_session=');
    expect(second.cookie).toContain('of_session=');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM owners WHERE clerk_user_id=?')
      .bind(sub)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const session = await auth.session(
      new Request(origin, { headers: { Cookie: first.cookie.split(';')[0] ?? '' } }),
    );
    expect(session?.owner.email).toBe('race@example.com');
    expect(session?.owner.id).not.toBe('owner');
  });

  it('keeps REST, MCP, health, uploads, revoke, and deletion inside one owner', async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const a = await signIn('user_a_' + suffix, 'a@example.com', 'sess_a_' + suffix);
    const b = await signIn('user_b_' + suffix, 'b@example.com', 'sess_b_' + suffix);
    const operation = () => crypto.randomUUID();
    const created = async (cookie: string, path: string, body: unknown) => {
      const response = await api(cookie, 'POST', path, body);
      expect(response.status, await response.clone().text()).toBe(200);
      return jsonOf(response);
    };
    const food = await created(a.cookie, '/api/v1/foods', {
      operationId: operation(),
      data: {
        name: 'Tenant A rice ' + suffix,
        basis: { quantity: 100, unit: 'g' },
        nutrients: { energyKcal: 130 },
        source: { kind: 'bot_estimate', basis: 'Isolation fixture.' },
      },
    });
    const exercise = await created(a.cookie, '/api/v1/exercises', {
      operationId: operation(),
      data: { name: 'Tenant A press ' + suffix },
    });
    const plan = await created(a.cookie, '/api/v1/training-plans', {
      operationId: operation(),
      data: {
        name: 'Tenant A plan ' + suffix,
        exercises: [{ exerciseId: exercise.data.id, sets: [{ reps: 5, weightKg: 20 }] }],
      },
    });
    const workout = await created(a.cookie, '/api/v1/workouts', {
      operationId: operation(),
      name: 'Tenant A workout ' + suffix,
    });
    const meal = await created(a.cookie, '/api/v1/meals', {
      operationId: operation(),
      occurredAt: '2026-10-21T12:00:00-04:00',
      ingredients: [
        {
          quantity: 100,
          unit: 'g',
          food: {
            name: 'Tenant A meal rice ' + suffix,
            basis: { quantity: 100, unit: 'g' },
            nutrients: { energyKcal: 130 },
            source: { kind: 'bot_estimate', basis: 'Isolation fixture.' },
          },
        },
      ],
    });
    const upload = await created(a.cookie, '/api/v1/media/uploads', {
      operationId: operation(),
      contentType: 'image/png',
    });
    for (const [path, id] of [
      ['/api/v1/foods/', food.data.id],
      ['/api/v1/exercises/', exercise.data.id],
      ['/api/v1/training-plans/', plan.data.id],
      ['/api/v1/workouts/', workout.data.id],
      ['/api/v1/meals/', meal.data.id],
      ['/api/v1/media/', upload.data.asset.id],
    ] as const) {
      const hidden = await api(b.cookie, 'GET', path + id);
      expect(hidden.status).toBe(404);
      expect(((await hidden.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
    const listed = await api(b.cookie, 'GET', '/api/v1/foods');
    expect(JSON.stringify(await listed.json())).not.toContain('Tenant A rice ' + suffix);
    const uploadPath = new URL(upload.data.uploadUrl).pathname;
    const crossed = await api(b.cookie, 'PUT', uploadPath);
    expect(crossed.status).toBe(404);

    const tokenA = await authorize(a.cookie, 'fitness:full offline_access health:sync');
    const tokenB = await authorize(b.cookie, 'fitness:full offline_access health:sync');
    const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + tokenB } },
      fetch: async (input, init) => {
        const ctx = createExecutionContext();
        const response = await createApp(runtime()).fetch(new Request(input, init), runtime(), ctx);
        await waitOnExecutionContext(ctx);
        return response;
      },
    });
    const client = new Client({ name: 'Tenant B', version: '1.0.0' });
    await client.connect(transport);
    const missing = (await client.callTool({
      name: 'get_exercise',
      arguments: { id: exercise.data.id },
    })) as { isError?: boolean };
    expect(missing.isError).toBe(true);
    await client.close();

    const enrolledA = await request('/api/v1/health/devices', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokenA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: operation(), name: 'Phone A ' + suffix }),
    });
    expect(enrolledA.status).toBe(200);
    const deviceA = (
      (await enrolledA.json()) as { data: { deviceId: string; deviceSecret: string } }
    ).data;
    const writer = await request('/api/v1/health/writer', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + tokenA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: operation(), ...deviceA }),
    });
    expect(writer.status).toBe(200);
    const enrolledB = await request('/api/v1/health/devices', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokenB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: operation(), name: 'Phone B ' + suffix }),
    });
    const deviceB = (
      (await enrolledB.json()) as { data: { deviceId: string; deviceSecret: string } }
    ).data;
    await request('/api/v1/health/writer', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + tokenB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: operation(), ...deviceB }),
    });
    const claimB = await request('/api/v1/health/exports/claim', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokenB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: operation(), ...deviceB, limit: 10 }),
    });
    expect(claimB.status).toBe(200);
    expect(JSON.stringify(await claimB.json())).not.toContain(meal.data.id);

    const bots = await env.DB.prepare(
      "SELECT id FROM bots WHERE owner_id=? AND status='active' ORDER BY created_at DESC",
    )
      .bind(b.ownerId)
      .first<{ id: string }>();
    const revoke = await api(a.cookie, 'POST', '/admin/bots/' + bots?.id + '/revoke');
    expect(revoke.status).toBe(303);
    const still = await request('/api/v1/agent-context', {
      headers: { Authorization: 'Bearer ' + tokenB },
    });
    expect(still.status).toBe(200);

    const revokedSession = await webhook(
      { type: 'session.revoked', data: { id: 'sess_a_' + suffix } },
      'msg_revoke_' + suffix,
    );
    expect(revokedSession.status).toBe(200);
    expect(await a.auth.session(new Request(origin, { headers: { Cookie: a.cookie } }))).toBeNull();
    expect(
      await b.auth.session(new Request(origin, { headers: { Cookie: b.cookie } })),
    ).not.toBeNull();
    const again = await signIn('user_a_' + suffix, 'a@example.com', 'sess_a2_' + suffix);
    const deleted = await webhook(
      { type: 'user.deleted', data: { id: 'user_a_' + suffix } },
      'msg_delete_' + suffix,
    );
    expect(deleted.status).toBe(200);
    const replay = await webhook(
      { type: 'user.deleted', data: { id: 'user_a_' + suffix } },
      'msg_delete_' + suffix,
    );
    expect(replay.status).toBe(200);
    expect(
      await again.auth.session(new Request(origin, { headers: { Cookie: again.cookie } })),
    ).toBeNull();
    expect(
      (await request('/api/v1/agent-context', { headers: { Authorization: 'Bearer ' + tokenA } }))
        .status,
    ).toBe(401);
    expect(
      await b.auth.session(new Request(origin, { headers: { Cookie: b.cookie } })),
    ).not.toBeNull();
    expect(
      (await request('/api/v1/agent-context', { headers: { Authorization: 'Bearer ' + tokenB } }))
        .status,
    ).toBe(200);
    const forged = await webhook(
      { type: 'user.deleted', data: { id: 'user_b_' + suffix } },
      'bad',
      'v1,aaaa',
    );
    expect(forged.status).toBe(401);
    const email = await webhook(
      {
        type: 'user.updated',
        data: {
          id: 'user_b_' + suffix,
          primary_email_address_id: 'idn_1',
          email_addresses: [{ id: 'idn_1', email_address: 'b-updated@example.com' }],
        },
      },
      'msg_email_' + suffix,
    );
    expect(email.status).toBe(200);
    expect(
      (
        await env.DB.prepare('SELECT email FROM owners WHERE id=?')
          .bind(b.ownerId)
          .first<{ email: string }>()
      )?.email,
    ).toBe('b-updated@example.com');
  });
});
