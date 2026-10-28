import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app';
import { D1Repository } from '../src/adapters/cloudflare';
import { AuthService } from '../src/auth';
import { ClerkIdentityVerifier } from '../src/adapters/clerk';
import { base64url, canonical, randomToken, sha256 } from '../src/crypto';
import { FitnessService } from '../src/domain/service';
import { stageSyncChange, startFitnessSync } from '../src/sync/client';
import { encodeFeedCursor } from '../src/sync/feed';
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

const oats = {
  name: 'Cooked oats',
  basis: { quantity: 100, unit: 'g' as const },
  preparation: 'cooked' as const,
  nutrients: { energyKcal: 71, proteinG: 2.5, carbohydrateG: 12, fatG: 1.5 },
  source: { kind: 'user' as const },
};

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
async function clerkToken(sub: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signClerkTestToken(keys.privatePem, {
    sub,
    sid: 'sess_' + sub,
    azp: origin,
    iat: now,
    nbf: now,
    exp: now + 60,
  });
}
async function request(path: string, init?: RequestInit): Promise<Response> {
  const bindings = runtime();
  const ctx = createExecutionContext();
  const response = await createApp(bindings).fetch(new Request(origin + path, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function signIn(sub: string, email: string): Promise<{ cookie: string; ownerId: string }> {
  const bindings = runtime();
  const auth = authFor(email, bindings);
  const exchanged = await auth.exchangeClerkSession(
    new Request(origin + '/auth/clerk/session', {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer ' + (await clerkToken(sub)) },
    }),
    {},
  );
  const cookie = exchanged.cookie.split(';')[0]!;
  const session = await auth.session(new Request(origin, { headers: { Cookie: cookie } }));
  if (!session) throw new Error('expected a session');
  return { cookie, ownerId: session.owner.id };
}
async function readJson(response: Response): Promise<{ data?: any; error?: { code: string } }> {
  return (await response.json()) as { data?: any; error?: { code: string } };
}
async function api(cookie: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await request(path, {
    method,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(payload.error?.code ?? String(response.status));
  return payload.data;
}
async function bearer(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return request(path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function issueBearer(sessionCookie: string): Promise<string> {
  const auth = new AuthService(runtime());
  const redirectUri = 'https://client.example/callback';
  const client = await auth.helpers().createClient({
    clientName: 'Feed client',
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
    scope: 'fitness:full offline_access',
    resource: origin,
    state: 'feed',
  });
  const page = await request('/authorize?' + query, { headers: { Cookie: sessionCookie } });
  expect(page.status).toBe(200);
  const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)?.[1];
  expect(handle).toBeTruthy();
  const consent =
    sessionCookie +
    '; ' +
    page.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
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
  const code = new URL(approval.headers.get('Location')!).searchParams.get('code');
  const tokenResponse = await request('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: code!,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: origin,
    }),
  });
  const tokens = (await tokenResponse.json()) as { access_token?: string };
  expect(tokenResponse.status).toBe(200);
  return tokens.access_token!;
}
function socketHeaders(extra: Record<string, string>): Headers {
  return new Headers({
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': btoa(crypto.randomUUID()),
    'Sec-WebSocket-Version': '13',
    ...extra,
  });
}
async function openEvents(extra: Record<string, string>) {
  const response = await request('/api/v1/sync/events', { headers: socketHeaders(extra) });
  if (response.status !== 101 || !response.webSocket)
    throw new Error(`events upgrade failed: ${response.status} ${await response.text()}`);
  const ws = response.webSocket;
  const messages: string[] = [];
  const closes: number[] = [];
  ws.addEventListener('message', (event) => {
    messages.push(String(event.data));
  });
  ws.addEventListener('close', (event) => {
    closes.push((event as CloseEvent).code);
  });
  (ws as WebSocket & { accept?: () => void }).accept?.();
  return { ws, messages, closes };
}
async function connect(cookie: string) {
  const response = await request('/api/v1/sync', { headers: socketHeaders({ Cookie: cookie }) });
  if (response.status !== 101 || !response.webSocket)
    throw new Error(`sync upgrade failed: ${response.status}`);
  return startFitnessSync(response.webSocket);
}
async function waitFor(label: string, check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
function mealBody(foodId: string, operationId = crypto.randomUUID(), id?: string) {
  return {
    operationId,
    ...(id ? { id } : {}),
    occurredAt: '2026-10-27T15:00:00.000Z',
    ingredients: [{ foodId, quantity: 80, unit: 'g' as const }],
  };
}

describe('document change feed', () => {
  it('pages saves, replays, tombstones, and raw updates in seq order', async () => {
    const owner = await signIn('feed-contents', 'feed-contents@example.test');
    const context = await api(owner.cookie, 'GET', '/api/v1/agent-context');
    expect(context.capabilities.syncFeed).toBe(1);
    const firstOperation = crypto.randomUUID();
    const first = await api(owner.cookie, 'POST', '/api/v1/foods', {
      operationId: firstOperation,
      id: 'feed-oats',
      data: oats,
    });
    const second = await api(owner.cookie, 'POST', '/api/v1/foods', {
      operationId: crypto.randomUUID(),
      id: 'feed-rice',
      data: { ...oats, name: 'Cooked rice' },
    });
    const meal = await api(
      owner.cookie,
      'POST',
      '/api/v1/meals',
      mealBody(first.id, crypto.randomUUID(), crypto.randomUUID()),
    );
    const page = await api(owner.cookie, 'GET', '/api/v1/sync/changes?limit=1');
    expect(page.reset).toBe(false);
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(first.id);
    expect(page.items[0].seq).toBeGreaterThan(0);
    expect(page.account).toMatchObject({ ownerId: owner.ownerId, timeZone: 'America/New_York' });
    const rest = await api(
      owner.cookie,
      'GET',
      '/api/v1/sync/changes?limit=10&after=' + encodeURIComponent(page.cursor),
    );
    expect(rest.hasMore).toBe(false);
    expect(rest.items.map((item: { id: string }) => item.id)).toEqual([second.id, meal.id]);
    const before = [...page.items, ...rest.items].map((item: { seq: number }) => item.seq);
    const replayed = await request('/api/v1/foods', {
      method: 'POST',
      headers: { Cookie: owner.cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: firstOperation, id: 'feed-oats', data: oats }),
    });
    expect(replayed.status).toBe(200);
    expect((await readJson(replayed)).data.id).toBe(first.id);
    const afterReplay = await api(owner.cookie, 'GET', '/api/v1/sync/changes?limit=10');
    expect(afterReplay.items.map((item: { seq: number }) => item.seq)).toEqual(before);

    await api(owner.cookie, 'DELETE', '/api/v1/meals/' + meal.id, {
      operationId: crypto.randomUUID(),
      expectedVersion: meal.version,
    });
    const tombstone = (await api(owner.cookie, 'GET', '/api/v1/sync/changes?limit=10')).items.find(
      (item: { id: string }) => item.id === meal.id,
    );
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.version).toBe(meal.version + 1);
    expect(tombstone.seq).toBeGreaterThan(before.at(-1)!);

    const row = await env.DB.prepare(
      'SELECT data, version FROM documents WHERE owner_id=? AND kind=? AND id=?',
    )
      .bind(owner.ownerId, 'food', second.id)
      .first<{ data: string; version: number }>();
    const data = JSON.parse(row!.data) as { name: string };
    data.name = 'Cleaned rice';
    await env.DB.prepare(
      'UPDATE documents SET data=?, version=?, updated_at=? WHERE owner_id=? AND kind=? AND id=?',
    )
      .bind(
        JSON.stringify(data),
        row!.version + 1,
        '2026-10-27T18:00:00.000Z',
        owner.ownerId,
        'food',
        second.id,
      )
      .run();
    const cleaned = (await api(owner.cookie, 'GET', '/api/v1/sync/changes?limit=10')).items.find(
      (item: { id: string }) => item.id === second.id,
    );
    expect(cleaned.version).toBe(row!.version + 1);
    expect(cleaned.data.name).toBe('Cleaned rice');
    expect(cleaned.seq).toBeGreaterThan(tombstone.seq);

    const budget = await new D1Repository(env.DB).changes(owner.ownerId, 0, 50, 1);
    expect(budget.items.length).toBe(1);
    expect(budget.hasMore).toBe(true);
  });

  it('pokes an events socket for MCP meals and preference changes, and isolates owners', async () => {
    const owner = await signIn('feed-mcp', 'feed-mcp@example.test');
    const other = await signIn('feed-other', 'feed-other@example.test');
    const token = await issueBearer(owner.cookie);
    const events = await openEvents({ Authorization: 'Bearer ' + token });
    const stranger = await openEvents({ Cookie: other.cookie });
    try {
      await waitFor(
        'ready',
        () =>
          events.messages.some((message) => message.includes('"ready"')) &&
          stranger.messages.some((message) => message.includes('"ready"')),
      );
      const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + token } },
        fetch: async (input, init) => {
          const href = typeof input === 'string' ? input : input.href;
          const url = new URL(href);
          return request(url.pathname + url.search, init);
        },
      });
      const client = new Client({ name: 'Feed', version: '1.0.0' });
      await client.connect(transport);
      const mealId = crypto.randomUUID();
      const logged = (await client.callTool({
        name: 'log_meal',
        arguments: {
          operationId: crypto.randomUUID(),
          id: mealId,
          occurredAt: '2026-10-27T12:00:00Z',
          ingredients: [
            {
              quantity: 100,
              unit: 'g',
              food: {
                name: 'MCP oats',
                basis: { quantity: 100, unit: 'g' },
                nutrients: { energyKcal: 70, proteinG: 2, carbohydrateG: 12, fatG: 1, fiberG: 1 },
                source: { kind: 'user' },
              },
            },
          ],
        },
      })) as { isError?: boolean; structuredContent?: { data?: { id?: string } } };
      expect(logged.isError).not.toBe(true);
      expect(logged.structuredContent?.data?.id).toBe(mealId);
      await waitFor(
        'meal poke',
        () => events.messages.filter((message) => message.includes('"changed"')).length >= 1,
      );
      const listed = (await client.callTool({
        name: 'list_changes',
        arguments: { limit: 20 },
      })) as { structuredContent?: { data?: { items: { id: string; kind: string }[] } } };
      expect(
        listed.structuredContent?.data?.items.some(
          (item) => item.id === mealId && item.kind === 'meal',
        ),
      ).toBe(true);
      await client.close();

      const changedBefore = stranger.messages.filter((message) => message.includes('"changed"'));
      expect(changedBefore).toEqual([]);
      const foreign = await api(owner.cookie, 'GET', '/api/v1/sync/changes?limit=5');
      const mismatch = await request(
        '/api/v1/sync/changes?after=' + encodeURIComponent(foreign.cursor),
        { headers: { Cookie: other.cookie } },
      );
      expect(mismatch.status).toBe(409);
      expect((await readJson(mismatch)).error?.code).toBe('SYNC_OWNER_MISMATCH');
      const hidden = await api(other.cookie, 'GET', '/api/v1/sync/changes?limit=20');
      expect(hidden.items.some((item: { id: string }) => item.id === mealId)).toBe(false);

      await api(owner.cookie, 'PUT', '/api/v1/preferences', {
        operationId: crypto.randomUUID(),
        timeZone: 'Asia/Tokyo',
      });
      await waitFor(
        'preference poke',
        () => events.messages.filter((message) => message.includes('"changed"')).length >= 2,
      );
      const next = await api(owner.cookie, 'GET', '/api/v1/sync/changes?limit=1');
      expect(next.account.timeZone).toBe('Asia/Tokyo');
      expect(stranger.messages.filter((message) => message.includes('"changed"'))).toEqual([]);
    } finally {
      events.ws.close();
      stranger.ws.close();
    }
  });

  it('resets a bad cursor and keeps another owner cursor as a conflict', async () => {
    const owner = await signIn('feed-cursor', 'feed-cursor@example.test');
    const malformed = await api(
      owner.cookie,
      'GET',
      '/api/v1/sync/changes?after=' + encodeURIComponent('@@@'),
    );
    expect(malformed).toMatchObject({ reset: true, items: [], cursor: null, hasMore: false });
    const stale = base64url(
      new TextEncoder().encode(JSON.stringify({ v: 1, e: 99, o: owner.ownerId, s: 0 })),
    );
    const epoch = await api(
      owner.cookie,
      'GET',
      '/api/v1/sync/changes?after=' + encodeURIComponent(stale),
    );
    expect(epoch.reset).toBe(true);
    expect(encodeFeedCursor(owner.ownerId, 0)).not.toBe(stale);
  });

  it('keeps a client meal UUID and rejects a non-UUID or a reused id', async () => {
    const owner = await signIn('feed-meal-id', 'feed-meal-id@example.test');
    const food = await api(owner.cookie, 'POST', '/api/v1/foods', {
      operationId: crypto.randomUUID(),
      data: oats,
    });
    const id = crypto.randomUUID();
    const saved = await api(
      owner.cookie,
      'POST',
      '/api/v1/meals',
      mealBody(food.id, crypto.randomUUID(), id),
    );
    expect(saved.id).toBe(id);
    const invalid = await request('/api/v1/meals', {
      method: 'POST',
      headers: { Cookie: owner.cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(mealBody(food.id, crypto.randomUUID(), 'meal-local')),
    });
    expect(invalid.status).toBe(422);
    const reused = await request('/api/v1/meals', {
      method: 'POST',
      headers: { Cookie: owner.cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(mealBody(food.id, crypto.randomUUID(), id)),
    });
    expect(reused.status).toBe(422);
    expect((await readJson(reused)).error?.code).toBe('EXPECTED_VERSION_REQUIRED');
    const fromRecipeFood = food;
    const recipe = await api(owner.cookie, 'POST', '/api/v1/recipes', {
      operationId: crypto.randomUUID(),
      data: {
        name: 'Oat bowl',
        ingredients: [{ id: 'oats', foodId: fromRecipeFood.id, quantity: 100, unit: 'g' }],
        yield: { servings: 1 },
      },
    });
    const recipeMealId = crypto.randomUUID();
    const fromRecipe = await api(owner.cookie, 'POST', '/api/v1/meals/from-recipe', {
      operationId: crypto.randomUUID(),
      id: recipeMealId,
      recipeId: recipe.id,
      occurredAt: '2026-10-27T16:00:00Z',
    });
    expect(fromRecipe.id).toBe(recipeMealId);
  });

  it('replays one operation across bots and still accepts a legacy actor hash', async () => {
    const owner = await signIn('feed-replay', 'feed-replay@example.test');
    const tokenA = await issueBearer(owner.cookie);
    const tokenB = await issueBearer(owner.cookie);
    const operationId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const body = { operationId, id, data: oats };
    const first = await bearer(tokenA, 'POST', '/api/v1/foods', body);
    const second = await bearer(tokenB, 'POST', '/api/v1/foods', body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await readJson(second)).data.id).toBe(id);
    const changed = await bearer(tokenB, 'POST', '/api/v1/foods', {
      ...body,
      data: { ...oats, name: 'Different oats' },
    });
    expect(changed.status).toBe(409);
    expect((await readJson(changed)).error?.code).toBe('IDEMPOTENCY_CONFLICT');

    const actor = {
      ownerId: 'owner',
      id: 'legacy-bot',
      kind: 'owner' as const,
      locale: 'en' as const,
      timeZone: 'America/New_York',
    };
    const service = new FitnessService(new D1Repository(env.DB), actor, {
      lookup: async () => ({ food: null, stale: false }),
      search: async () => ({ items: [], catalogStatus: 'ok' }),
      refresh: async () => {
        throw new Error('unused');
      },
    });
    const raw = {
      operationId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      data: oats,
    };
    const args = service.operations.get('save_food')!.schema.parse(raw);
    const legacy = await sha256(canonical({ name: 'save_food', args, actor: actor.id }));
    const stored = { id: raw.id, legacy: true };
    await env.DB.prepare('INSERT INTO operations VALUES(?,?,?,?,?)')
      .bind(
        actor.ownerId,
        raw.operationId,
        legacy,
        JSON.stringify(stored),
        new Date().toISOString(),
      )
      .run();
    await expect(service.execute('save_food', raw)).resolves.toEqual(stored);
  });

  it('publishes one meal when identical creates race', async () => {
    const owner = await signIn('feed-race', 'feed-race@example.test');
    const phone = await connect(owner.cookie);
    try {
      const food = await api(owner.cookie, 'POST', '/api/v1/foods', {
        operationId: crypto.randomUUID(),
        data: oats,
      });
      const body = mealBody(food.id, crypto.randomUUID());
      const headers = {
        Cookie: owner.cookie,
        Origin: origin,
        'Content-Type': 'application/json',
      };
      const [left, right] = await Promise.all([
        request('/api/v1/meals', { method: 'POST', headers, body: JSON.stringify(body) }),
        request('/api/v1/meals', { method: 'POST', headers, body: JSON.stringify(body) }),
      ]);
      expect(left.status).toBe(200);
      expect(right.status).toBe(200);
      const mealId = (await readJson(left)).data.id as string;
      expect((await readJson(right)).data.id).toBe(mealId);
      await waitFor('racing meal', () => phone.store.getRow('meal', mealId).version === 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(phone.store.getRowIds('meal')).toEqual([mealId]);
    } finally {
      await phone.stop();
    }
  });

  it('requires auth and an upgrade, closes expired sockets, and pokes for TinyBase edits', async () => {
    const anonymous = await request('/api/v1/sync/events');
    expect(anonymous.status).toBe(401);
    const owner = await signIn('feed-events', 'feed-events@example.test');
    const plain = await request('/api/v1/sync/events', { headers: { Cookie: owner.cookie } });
    expect(plain.status).toBe(426);

    const expiredId = env.FITNESS_EVENTS.idFromName(owner.ownerId + '-expired');
    const expiredStub = env.FITNESS_EVENTS.get(expiredId);
    const expired = await expiredStub.fetch(
      new Request('http://events/' + owner.ownerId + '?expiresAt=1', {
        headers: socketHeaders({}),
      }),
    );
    expect(expired.status).toBe(101);
    const expiredSocket = expired.webSocket!;
    const expiredClose = new Promise<number>((resolve) => {
      expiredSocket.addEventListener('close', (event) => resolve((event as CloseEvent).code));
    });
    (expiredSocket as WebSocket & { accept?: () => void }).accept?.();
    expect(await expiredClose).toBe(4001);

    const soon = Date.now() + 40;
    const soonStub = env.FITNESS_EVENTS.get(env.FITNESS_EVENTS.idFromName(owner.ownerId + '-soon'));
    const soonResponse = await soonStub.fetch(
      new Request('http://events/' + owner.ownerId + '?expiresAt=' + soon, {
        headers: socketHeaders({}),
      }),
    );
    const soonSocket = soonResponse.webSocket!;
    const soonCloses: number[] = [];
    soonSocket.addEventListener('close', (event) => {
      soonCloses.push((event as CloseEvent).code);
    });
    (soonSocket as WebSocket & { accept?: () => void }).accept?.();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await soonStub.notify();
    await waitFor('expiry close', () => soonCloses.includes(4001));

    const events = await openEvents({ Cookie: owner.cookie });
    const phone = await connect(owner.cookie);
    try {
      await waitFor('events ready', () =>
        events.messages.some((message) => message.includes('"ready"')),
      );
      const stagedId = crypto.randomUUID();
      stageSyncChange(phone.store, 'food', stagedId, oats);
      await waitFor(
        'staged poke',
        () => events.messages.filter((message) => message.includes('"changed"')).length >= 1,
      );
      const page = await api(owner.cookie, 'GET', '/api/v1/sync/changes?limit=20');
      expect(page.items.some((item: { id: string }) => item.id === stagedId)).toBe(true);
    } finally {
      events.ws.close();
      await phone.stop();
    }
  });
});
