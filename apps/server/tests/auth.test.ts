import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app';
import { AuthService, safeReturn } from '../src/auth';
import { base64url, randomToken, sha256 } from '../src/crypto';

const origin = 'http://localhost:8787';
async function request(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await createApp(env).fetch(new Request(origin + path, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function cookieValues(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}
async function ownerSession(): Promise<string> {
  const token = randomToken();
  const owner = await new AuthService(env).owner();
  await env.DB.batch([
    env.DB.prepare("UPDATE owners SET setup_completed=1 WHERE id='owner'"),
    env.DB.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(
      await sha256(token),
      owner.session_epoch,
      Date.now() + 600000,
    ),
  ]);
  return 'of_session=' + token;
}
async function grant(
  decision: 'allow' | 'deny' = 'allow',
  metadataClientId?: string,
  scope = 'fitness:full offline_access',
  redirectUri = 'https://client.example/callback',
) {
  const auth = new AuthService(env);
  const client = metadataClientId
    ? { clientId: metadataClientId }
    : await auth.helpers().createClient({
        clientName: 'Acceptance client',
        redirectUris: [redirectUri],
        tokenEndpointAuthMethod: 'none',
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
      });
  const verifier = randomToken();
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    resource: origin,
    state: 'test-state',
  });
  const session = await ownerSession();
  const page = await request('/authorize?' + query, { headers: { Cookie: session } });
  expect(page.status).toBe(200);
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  expect(handle).toBeTruthy();
  const consentCookies = session + '; ' + cookieValues(page);
  const approval = await request('/authorize', {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: consentCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ handle: handle!, decision }),
  });
  expect(approval.status).toBe(303);
  const location = new URL(approval.headers.get('Location')!);
  return { auth, client, verifier, location, handle, cookies: consentCookies, html };
}
async function exchange(
  clientId: string,
  code: string,
  verifier: string,
  redirectUri = 'https://client.example/callback',
) {
  return request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: origin,
    }),
  });
}

describe('passkey boundaries', () => {
  it('registers a native redirect and preserves separately approved HealthKit permission', async () => {
    const owner = await new AuthService(env).owner();
    try {
      const redirect = 'org.openfitness.app:/oauth/callback';
      const registration = await request('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'OpenFitness iOS',
          redirect_uris: [redirect],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const approved = await grant(
        'allow',
        client.client_id,
        'fitness:full offline_access health:sync',
        redirect,
      );
      expect(approved.html).toContain('Apple Health');
      expect(approved.location.protocol).toBe('org.openfitness.app:');
      expect(approved.location.searchParams.get('iss')).toBe(origin);
      const response = await exchange(
        client.client_id,
        approved.location.searchParams.get('code')!,
        approved.verifier,
        redirect,
      );
      expect(response.status).toBe(200);
      const tokens = (await response.json()) as { access_token: string; scope: string };
      expect(tokens.scope.split(' ')).toContain('health:sync');
      const enrolled = await request('/api/v1/health/devices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + tokens.access_token,
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          name: 'Native acceptance iPhone',
        }),
      });
      expect(enrolled.status).toBe(200);
      expect(await enrolled.json()).toMatchObject({
        data: { deviceId: expect.any(String), deviceSecret: expect.any(String) },
      });
    } finally {
      await env.DB.prepare('UPDATE owners SET setup_completed=? WHERE id=?')
        .bind(owner.setup_completed, owner.id)
        .run();
    }
  });
  it('keeps post-login redirects on this service, including browser-normalized control characters', () => {
    for (const value of [
      'https://attacker.example',
      '//attacker.example',
      '/\\attacker.example',
      '/\t/attacker.example',
      '/\n/attacker.example',
    ])
      expect(safeReturn(value)).toBe('/admin');
    expect(safeReturn('/authorize?scope=fitness%3Afull+offline_access')).toBe(
      '/authorize?scope=fitness%3Afull+offline_access',
    );
  });
  it('rejects malformed authentication payloads with stable input errors', async () => {
    for (const [path, value] of [
      ['/auth/passkeys/registration-options', null],
      ['/auth/passkeys/registration-options', { setupToken: 123 }],
      ['/auth/passkeys/register', { response: {}, name: 123 }],
      ['/auth/passkeys/authenticate', null],
      ['/auth/passkeys/authenticate', { response: [] }],
    ] as const) {
      const response = await request(path, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      expect(response.status).toBe(422);
      expect(((await response.json()) as any).error.code).toBe('INVALID_INPUT');
    }
  });
  it('requires the setup secret and binds challenges to the browser, purpose, origin, and expiry', async () => {
    const missing = await request('/auth/passkeys/registration-options', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(403);
    const wrongOrigin = await request('/auth/passkeys/registration-options', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: env.SETUP_TOKEN }),
    });
    expect(wrongOrigin.status).toBe(403);
    const options = await request('/auth/passkeys/registration-options', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: env.SETUP_TOKEN }),
    });
    expect(options.status).toBe(200);
    const cookie = cookieValues(options);
    const auth = new AuthService(env);
    await expect(
      auth.register(new Request(origin, { method: 'POST', headers: { Origin: origin } }), {
        response: {},
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_REQUIRED' });
    await expect(
      auth.register(
        new Request(origin, { method: 'POST', headers: { Origin: origin, Cookie: cookie } }),
        { response: {} },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PASSKEY' });
    await expect(
      auth.register(
        new Request(origin, { method: 'POST', headers: { Origin: origin, Cookie: cookie } }),
        { response: {} },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CHALLENGE' });
    const login = await request('/auth/passkeys/authentication-options', {
      method: 'POST',
      headers: { Origin: origin },
    });
    await env.DB.prepare('UPDATE auth_challenges SET expires_at=0 WHERE used_at IS NULL').run();
    await expect(
      auth.authenticate(
        new Request(origin, {
          method: 'POST',
          headers: { Origin: origin, Cookie: cookieValues(login) },
        }),
        {},
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CHALLENGE' });
  });
  it('serves translated pages and keeps validation codes stable across languages', async () => {
    const [en, zh] = await Promise.all([
      request('/setup', { headers: { 'Accept-Language': 'en' } }),
      request('/setup', { headers: { 'Accept-Language': 'zh-CN' } }),
    ]);
    expect(await en.text()).toContain('Set up OpenFitness');
    expect(await zh.text()).toContain('设置 OpenFitness');
    const fail = async (language: string) => {
      const response = await request('/auth/passkeys/registration-options', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'Accept-Language': language,
        },
        body: '{}',
      });
      return (await response.json()) as any;
    };
    const [a, b] = await Promise.all([fail('en'), fail('zh-CN')]);
    expect(a.error.code).toBe(b.error.code);
    expect(a.error.message).not.toBe(b.error.message);
  });
});

describe('OAuth and official MCP client interoperability', () => {
  it('authorizes a CIMD client and displays its verified publisher domain', async () => {
    const clientId = 'https://assistant.example/oauth-client.json';
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe(clientId);
      return Response.json({
        client_id: clientId,
        client_name: 'Metadata assistant',
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    });
    try {
      const result = await grant('allow', clientId);
      expect(result.html).toContain('Verified client domain');
      expect(result.html).toContain('<strong>assistant.example</strong>');
      const exchanged = await exchange(
        clientId,
        result.location.searchParams.get('code')!,
        result.verifier,
      );
      expect(exchanged.status).toBe(200);
      const tokens = (await exchanged.json()) as any;
      const context = await request('/api/v1/agent-context', {
        headers: { Authorization: 'Bearer ' + tokens.access_token },
      });
      expect(context.status).toBe(200);
      expect(((await context.json()) as any).data.actorType).toBe('bot');
    } finally {
      outbound.mockRestore();
    }
  });
  it('publishes discovery and challenges unauthenticated clients', async () => {
    const metadata = await request('/.well-known/oauth-authorization-server');
    expect(metadata.status).toBe(200);
    expect(((await metadata.json()) as any).code_challenge_methods_supported).toContain('S256');
    const unauthenticated = await request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('WWW-Authenticate')).toContain('resource_metadata');
  });
  it('denies consent and rejects a reused consent transaction', async () => {
    const result = await grant('deny');
    expect(result.location.searchParams.get('error')).toBe('access_denied');
    expect(result.location.searchParams.get('state')).toBe('test-state');
    const retry = await request('/authorize', {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: result.cookies,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ handle: result.handle!, decision: 'allow' }),
    });
    expect(retry.status).not.toBe(303);
  });
  it('rejects an incorrect PKCE verifier and a mismatched redirect URI', async () => {
    const result = await grant();
    const response = await exchange(
      result.client.clientId,
      result.location.searchParams.get('code')!,
      randomToken(),
    );
    expect(response.status).toBe(400);
    const invalid = await request(
      '/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: result.client.clientId,
          redirect_uri: 'https://attacker.example/callback',
          code_challenge: 'A'.repeat(43),
          code_challenge_method: 'S256',
          scope: 'fitness:full',
          resource: origin,
        }),
    );
    expect(invalid.status).not.toBe(303);
  });
  it('authorizes an agent, discovers and calls tools through the official SDK, and revokes access', async () => {
    const result = await grant();
    expect(result.location.searchParams.get('iss')).toBe(origin);
    const response = await exchange(
      result.client.clientId,
      result.location.searchParams.get('code')!,
      result.verifier,
    );
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as any;
    expect(tokens.refresh_token).toBeTruthy();
    const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } },
      fetch: async (input, init) => {
        const req = new Request(input, init);
        const ctx = createExecutionContext();
        const response = await createApp(env).fetch(req, env, ctx);
        await waitOnExecutionContext(ctx);
        return response;
      },
    });
    const client = new Client({ name: 'OpenFitness acceptance', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('log_meal_from_recipe');
    const context = (await client.callTool({ name: 'get_agent_context', arguments: {} })) as any;
    expect(context.structuredContent.data.actorType).toBe('bot');
    expect(context.structuredContent.data.permissions).toContain('full_business_access');
    const saved = (await client.callTool({
      name: 'save_exercise',
      arguments: { operationId: crypto.randomUUID(), data: { name: 'SDK exercise' } },
    })) as any;
    expect(saved.isError).not.toBe(true);
    expect(saved.structuredContent.data.data.name).toBe('SDK exercise');
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as any;
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      return result.structuredContent.data;
    };
    const plan = await call('save_training_plan', {
      operationId: crypto.randomUUID(),
      data: {
        name: 'SDK training',
        exercises: [
          { exerciseId: saved.structuredContent.data.id, sets: [{ reps: 5, weightKg: 20 }] },
        ],
      },
    });
    let workout = await call('start_workout', {
      operationId: crypto.randomUUID(),
      planId: plan.id,
    });
    workout = await call('log_workout_set', {
      operationId: crypto.randomUUID(),
      workoutId: workout.id,
      expectedVersion: workout.version,
      exerciseId: saved.structuredContent.data.id,
      set: { reps: 5, weightKg: 20 },
    });
    workout = await call('finish_workout', {
      operationId: crypto.randomUUID(),
      id: workout.id,
      expectedVersion: workout.version,
    });
    expect(workout.data.state).toBe('completed');
    const recipe = await call('save_recipe', {
      operationId: crypto.randomUUID(),
      data: {
        name: 'SDK meal preset',
        yield: { servings: 1 },
        ingredients: [
          {
            id: 'rice',
            quantity: 200,
            unit: 'g',
            food: {
              name: 'Illustrative rice',
              basis: { quantity: 100, unit: 'g' },
              nutrients: { energyKcal: 130 },
              source: { kind: 'bot_estimate', basis: 'Synthetic MCP acceptance fixture.' },
            },
          },
        ],
      },
    });
    const meal = await call('log_meal_from_recipe', {
      operationId: crypto.randomUUID(),
      recipeId: recipe.id,
      occurredAt: '2026-10-20T16:00:00Z',
    });
    expect(meal.data.nutrients.energyKcal).toBe(260);
    const revised = await call('revise_meal', {
      operationId: crypto.randomUUID(),
      id: meal.id,
      expectedVersion: meal.version,
      overrides: [{ ingredientId: 'rice', quantity: 100 }],
    });
    expect(revised.data.nutrients.energyKcal).toBe(130);
    expect(revised.healthSync).toBe('awaiting_device');
    const pending = await call('create_media_upload', {
      operationId: crypto.randomUUID(),
      contentType: 'image/png',
    });
    const refresh = await request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: result.client.clientId,
        refresh_token: tokens.refresh_token,
        resource: origin,
      }),
    });
    expect(refresh.status).toBe(200);
    await client.close();
    await result.auth.revokeBot(context.structuredContent.data.actorId);
    const revoked = await request('/api/v1/agent-context', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    expect(revoked.status).toBe(401);
    const abandoned = await request(new URL(pending.uploadUrl).pathname, {
      method: 'PUT',
      body: new Uint8Array([137, 80, 78, 71]),
    });
    expect(abandoned.status).toBe(401);
    expect(((await abandoned.json()) as any).error.code).toBe('CONNECTION_REVOKED');
  });
  it('blocks cross-origin session mutations and returns a usable OpenAPI document', async () => {
    const cookie = await ownerSession();
    const response = await request('/api/v1/exercises', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://attacker.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operationId: crypto.randomUUID(), data: { name: 'Rejected' } }),
    });
    expect(response.status).toBe(403);
    const document = await request('/openapi.json');
    expect(document.status).toBe(200);
    const schema = (await document.json()) as any;
    expect(schema.paths['/api/v1/meals/from-recipe'].post.operationId).toBe('log_meal_from_recipe');
    expect(schema.paths['/api/v1/recipes/{id}']).toBeDefined();
  });
  it('recovers the owner atomically, invalidates all identities, and preserves fitness records', async () => {
    const result = await grant();
    const exchanged = await exchange(
      result.client.clientId,
      result.location.searchParams.get('code')!,
      result.verifier,
    );
    const tokens = (await exchanged.json()) as any;
    const headers = { Authorization: 'Bearer ' + tokens.access_token };
    const saved = await request('/api/v1/exercises', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        data: { name: 'Preserved exercise' },
      }),
    });
    const exercise = ((await saved.json()) as any).data;
    expect(saved.status).toBe(200);
    await env.DB.prepare(
      "UPDATE owners SET session_epoch=session_epoch+1,setup_completed=0 WHERE id='owner'",
    ).run();
    expect((await request('/api/v1/agent-context', { headers })).status).toBe(401);
    expect(
      await result.auth.session(new Request(origin, { headers: { Cookie: result.cookies } })),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM documents WHERE id=? AND deleted=0')
        .bind(exercise.id)
        .first(),
    ).toBeTruthy();
    expect((await request('/setup')).status).toBe(200);
  });
});
