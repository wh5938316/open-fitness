import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createApp } from '../src/app';
import { base64url, randomToken, sha256 } from '../src/crypto';
import {
  generateClerkTestKeys,
  signClerkTestToken,
  type ClerkTestKeys,
} from '../src/test-clerk-jwt';
import type { Env } from '../src/types';

const origin = 'http://localhost:8787';
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
function clerkEnv(extra: Partial<Env> = {}): Env {
  return withEnv({
    CLERK_JWT_KEY: keys.publicPem,
    CLERK_FRONTEND_API: 'https://clerk.example.test',
    CLERK_PUBLISHABLE_KEY: 'pk_test_example',
    CLERK_AUTO_PROVISION: 'false',
    ...extra,
  });
}
async function request(path: string, runtime: Env, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await createApp(runtime).fetch(new Request(origin + path, init), runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function clerkToken(
  privatePem: string,
  claims: Record<string, unknown> = {},
  omit: string[] = [],
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: 'user_bound',
    sid: 'sess_bound',
    azp: origin,
    iat: now,
    nbf: now,
    exp: now + 60,
    ...claims,
  };
  for (const key of omit) delete payload[key];
  return signClerkTestToken(privatePem, payload);
}
async function exchange(token: string, runtime: Env, init?: RequestInit): Promise<Response> {
  return request('/auth/clerk/session', runtime, {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    body: init?.body ?? JSON.stringify({ returnTo: '/admin' }),
  });
}

describe('Clerk session exchange', () => {
  it('rejects bad Clerk tokens and external return targets', async () => {
    const runtime = clerkEnv();
    const other = await generateClerkTestKeys();
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, RequestInit | undefined, number, string]> = [];
    const forged = await clerkToken(other.privatePem);
    const expired = await clerkToken(keys.privatePem, { exp: now - 120 });
    const wrongParty = await clerkToken(keys.privatePem, { azp: 'https://attacker.example' });
    const missingSid = await clerkToken(keys.privatePem, {}, ['sid']);
    cases.push(
      [forged, undefined, 401, 'INVALID_CLERK_TOKEN'],
      [expired, undefined, 401, 'INVALID_CLERK_TOKEN'],
      [wrongParty, undefined, 401, 'INVALID_CLERK_TOKEN'],
      [missingSid, undefined, 401, 'INVALID_CLERK_TOKEN'],
    );
    for (const [token, , status, code] of cases) {
      const response = await exchange(token, runtime);
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    const unbound = await exchange(
      await clerkToken(keys.privatePem, { sub: 'user_unbound' }),
      runtime,
    );
    expect(unbound.status).toBe(403);
    expect(((await unbound.json()) as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_NOT_PROVISIONED',
    );
    const disabledId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO owners(id,clerk_user_id,status,created_at) VALUES(?,'user_disabled','disabled',?)",
    )
      .bind(disabledId, Date.now())
      .run();
    const disabled = await exchange(
      await clerkToken(keys.privatePem, { sub: 'user_disabled', sid: 'sess_disabled' }),
      runtime,
    );
    expect(disabled.status).toBe(403);
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe(
      'OWNER_DISABLED',
    );
    const missingOrigin = await request('/auth/clerk/session', runtime, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + (await clerkToken(keys.privatePem)),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(missingOrigin.status).toBe(403);
    const external = await exchange(await clerkToken(keys.privatePem), runtime, {
      body: JSON.stringify({ returnTo: 'https://attacker.example' }),
    });
    expect(external.status).toBe(400);
    expect(((await external.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_RETURN_TO',
    );
    const cookieOnly = await request('/api/v1/agent-context', runtime, {
      headers: { Cookie: '__session=' + (await clerkToken(keys.privatePem)) },
    });
    expect(cookieOnly.status).toBe(401);
    const bearer = await request('/api/v1/agent-context', runtime, {
      headers: { Authorization: 'Bearer ' + (await clerkToken(keys.privatePem)) },
    });
    expect(bearer.status).toBe(401);
  });

  it('issues a local session for a bound owner and still accepts the legacy passkey session', async () => {
    const runtime = clerkEnv();
    await env.DB.prepare('UPDATE owners SET clerk_user_id=? WHERE id=?')
      .bind('user_bound', 'owner')
      .run();
    try {
      const response = await exchange(
        await clerkToken(keys.privatePem, { sid: 'sess_bound' }),
        runtime,
        { body: JSON.stringify({ returnTo: '/authorize?scope=fitness%3Afull' }) },
      );
      expect(response.status).toBe(200);
      expect(
        ((await response.clone().json()) as { data: { returnTo: string } }).data.returnTo,
      ).toBe('/authorize?scope=fitness%3Afull');
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith('of_session='));
      expect(cookie).toBeTruthy();
      const sessionValue = cookie!.split(';')[0]!.slice('of_session='.length);
      const row = await env.DB.prepare(
        'SELECT owner_id,clerk_session_id,epoch FROM sessions WHERE token_hash=?',
      )
        .bind(await sha256(sessionValue))
        .first<{ owner_id: string; clerk_session_id: string; epoch: number }>();
      const owner = await env.DB.prepare('SELECT session_epoch FROM owners WHERE id=?')
        .bind('owner')
        .first<{ session_epoch: number }>();
      expect(row).toMatchObject({
        owner_id: 'owner',
        clerk_session_id: 'sess_bound',
        epoch: owner?.session_epoch,
      });

      const verifier = randomToken();
      const challenge = base64url(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
      );
      const client = await request('/oauth/register', runtime, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Clerk exchange client',
          redirect_uris: ['https://client.example/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      expect(client.status).toBe(201);
      const clientId = ((await client.json()) as { client_id: string }).client_id;
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://client.example/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'fitness:full offline_access',
        resource: origin,
        state: 'clerk-state',
      });
      const page = await request('/authorize?' + query, runtime, {
        headers: { Cookie: 'of_session=' + sessionValue },
      });
      expect(page.status).toBe(200);
      const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)?.[1];
      const consentCookie = ['of_session=' + sessionValue]
        .concat(page.headers.getSetCookie().map((value) => value.split(';')[0]!))
        .join('; ');
      const approval = await request('/authorize', runtime, {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: consentCookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ handle: handle!, decision: 'allow' }),
      });
      expect(approval.status).toBe(303);
      const location = new URL(approval.headers.get('Location')!);
      const traded = await request('/oauth/token', runtime, {
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
      const access = ((await traded.json()) as { access_token: string }).access_token;
      const context = await request('/api/v1/agent-context', runtime, {
        headers: { Authorization: 'Bearer ' + access },
      });
      expect(context.status).toBe(200);

      const legacy = randomToken();
      await env.DB.prepare(
        'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,created_at) VALUES(?,?,?,?,?)',
      )
        .bind(await sha256(legacy), owner?.session_epoch, Date.now() + 600000, 'owner', Date.now())
        .run();
      const admin = await request('/admin', runtime, {
        headers: { Cookie: 'of_session=' + legacy },
      });
      expect(admin.status).toBe(200);
      expect(await admin.text()).toContain('Connected assistants');
    } finally {
      await env.DB.prepare('UPDATE owners SET clerk_user_id=NULL WHERE id=?').bind('owner').run();
    }
  });

  it('signs test tokens only for an explicit localhost test mode', async () => {
    const hidden = await request('/__test/clerk-token', clerkEnv(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sub: 'user_hidden' }),
    });
    expect(hidden.status).toBe(404);
    const enabled = clerkEnv({
      CLERK_TEST_MODE: '1',
      CLERK_TEST_PRIVATE_KEY: keys.privatePem,
    });
    const minted = await request('/__test/clerk-token', enabled, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sub: 'user_bound', sid: 'sess_route' }),
    });
    expect(minted.status).toBe(200);
    const token = ((await minted.json()) as { data: { token: string } }).data.token;
    expect(token.split('.')).toHaveLength(3);
    const remoteCtx = createExecutionContext();
    const remote = await createApp(enabled).fetch(
      new Request('https://fitness.example/__test/clerk-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: 'user_remote' }),
      }),
      enabled,
      remoteCtx,
    );
    await waitOnExecutionContext(remoteCtx);
    expect(remote.status).toBe(404);
  });

  it('relaxes Clerk CSP only on the sign-in and completion pages', async () => {
    const plain = await request('/sign-in', withEnv({}));
    expect(plain.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(plain.headers.get('Content-Security-Policy')).not.toContain('clerk.example.test');
    expect(plain.headers.get('Content-Security-Policy')).not.toContain('protect.clerk.com');
    const runtime = clerkEnv();
    const previous = await env.DB.prepare('SELECT setup_completed FROM owners WHERE id=?')
      .bind('owner')
      .first<{ setup_completed: number }>();
    await env.DB.prepare('UPDATE owners SET setup_completed=1 WHERE id=?').bind('owner').run();
    try {
      const signIn = await request('/sign-in', runtime);
      const policy = signIn.headers.get('Content-Security-Policy');
      expect(policy).toContain(
        "script-src 'self' https://clerk.example.test https://challenges.cloudflare.com https://*.protect.clerk.com",
      );
      expect(policy).toContain(
        "connect-src 'self' https://clerk.example.test https://clerk-telemetry.com https://*.clerk-telemetry.com https://*.protect.clerk.com:*",
      );
      expect(policy).toContain(
        "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com",
      );
      expect(await signIn.text()).toContain('data-clerk-key="pk_test_example"');
      const admin = await request('/admin', runtime);
      expect(admin.headers.get('Content-Security-Policy')).not.toContain('clerk.example.test');
      expect(admin.headers.get('Content-Security-Policy')).not.toContain('protect.clerk.com');
      const complete = await request('/auth/clerk/complete?returnTo=/admin', runtime);
      expect(complete.headers.get('Content-Security-Policy')).toContain(
        'https://*.protect.clerk.com:*',
      );
      expect(complete.headers.get('Content-Security-Policy')).toContain('https://img.clerk.com');
      const signOut = await request('/auth/clerk/sign-out', runtime);
      expect(signOut.headers.get('Content-Security-Policy')).toContain(
        'https://*.protect.clerk.com',
      );
    } finally {
      await env.DB.prepare('UPDATE owners SET setup_completed=? WHERE id=?')
        .bind(previous?.setup_completed ?? 0, 'owner')
        .run();
    }
  });

  it('forwards hashed auth chunks to ASSETS', async () => {
    const fetched: string[] = [];
    const assets: Env['ASSETS'] = {
      fetch(input: RequestInfo | URL, init?: RequestInit) {
        const request = new Request(input, init);
        fetched.push(new URL(request.url).pathname);
        return Promise.resolve(
          new Response('chunk', { headers: { 'content-type': 'text/javascript' } }),
        );
      },
      connect() {
        throw new Error('ASSETS.connect is not used');
      },
    };
    const runtime = withEnv({ ASSETS: assets });
    const chunk = await request('/auth-TQJJ5TGU.js', runtime);
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get('content-type')).toContain('javascript');
    expect(await chunk.text()).toBe('chunk');
    const localization = await request('/auth-2A7M5HZH.js', runtime);
    expect(localization.status).toBe(200);
    const entry = await request('/auth.js', runtime);
    expect(entry.status).toBe(200);
    expect(fetched).toEqual(['/auth-TQJJ5TGU.js', '/auth-2A7M5HZH.js', '/auth.js']);
    fetched.length = 0;
    for (const path of ['/auth-TQJJ5TGU.js.map', '/assets/auth-TQJJ5TGU.js', '/auth-.js']) {
      const rejected = await request(path, runtime);
      expect(rejected.status).toBe(404);
    }
    expect(fetched).toEqual([]);
  });
});
