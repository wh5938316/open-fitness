import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import type { MergeableStore } from 'tinybase';
import { createApp } from '../src/app';
import { AuthService } from '../src/auth';
import { ClerkIdentityVerifier } from '../src/adapters/clerk';
import {
  createLocalFitnessSynchronizer,
  createFitnessStore,
  stageSyncChange,
  startFitnessSync,
} from '../src/sync/client';
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
async function request(path: string, init?: RequestInit): Promise<Response> {
  const bindings = runtime();
  const ctx = createExecutionContext();
  const response = await createApp(bindings).fetch(new Request(origin + path, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function api(cookie: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await request(path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as { data?: any; error?: { code: string } };
  if (!response.ok) throw new Error(payload.error?.code ?? String(response.status));
  return payload.data;
}
async function connect(cookie: string) {
  const bindings = runtime();
  const ctx = createExecutionContext();
  const response = await createApp(bindings).fetch(
    new Request(origin + '/api/v1/sync', {
      headers: {
        Cookie: cookie,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': btoa(crypto.randomUUID()),
        'Sec-WebSocket-Version': '13',
      },
    }),
    bindings,
    ctx,
  );
  if (response.status !== 101 || !response.webSocket)
    throw new Error(`sync upgrade failed: ${response.status} ${await response.text()}`);
  return startFitnessSync(response.webSocket);
}
function record(store: MergeableStore, kind: string, id: string) {
  const row = store.getRow(kind, id);
  return {
    row,
    data:
      typeof row.body === 'string'
        ? (JSON.parse(row.body) as { name?: string; nutrients?: { energyKcal: number | null } })
        : undefined,
  };
}
async function waitFor(label: string, check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('local sync engine', () => {
  it('merges two local stores with the TinyBase synchronizer', async () => {
    const left = createFitnessStore();
    const right = createFitnessStore();
    const first = createLocalFitnessSynchronizer(left);
    const second = createLocalFitnessSynchronizer(right);
    try {
      await first.startSync();
      await second.startSync();
      stageSyncChange(left, 'food', 'local-oats', oats);
      await waitFor('local merge', () => right.getRow('food', 'local-oats').pending === 1);
      expect(JSON.parse(String(right.getRow('food', 'local-oats').body)).name).toBe('Cooked oats');
    } finally {
      await first.destroy();
      await second.destroy();
    }
  });

  it('requires a session and a WebSocket upgrade', async () => {
    const ctx = createExecutionContext();
    const anonymous = await createApp(env).fetch(new Request(origin + '/api/v1/sync'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(anonymous.status).toBe(401);
    const { cookie } = await signIn('sync-upgrade', 'sync-upgrade@example.test');
    const plain = await request('/api/v1/sync', { headers: { Cookie: cookie } });
    expect(plain.status).toBe(426);
  });

  it('replicates committed records, applies local edits, and keeps meal snapshots', async () => {
    const owner = await signIn('sync-owner', 'sync-owner@example.test');
    const other = await signIn('sync-other', 'sync-other@example.test');
    const [phone, tablet, stranger] = await Promise.all([
      connect(owner.cookie),
      connect(owner.cookie),
      connect(other.cookie),
    ]);
    try {
      const saved = await api(owner.cookie, 'POST', '/api/v1/foods', {
        operationId: crypto.randomUUID(),
        id: 'sync-oats',
        data: oats,
      });
      expect(saved.id).toBe('sync-oats');
      await waitFor(
        'food replica',
        () => record(phone.store, 'food', 'sync-oats').row.version === 1,
      );
      expect(record(tablet.store, 'food', 'sync-oats').data?.name).toBe('Cooked oats');
      expect(stranger.store.getRow('food', 'sync-oats').version).toBeUndefined();

      stageSyncChange(phone.store, 'recipe', 'sync-bowl', {
        name: 'Oat bowl',
        ingredients: [{ id: 'oats', foodId: 'sync-oats', quantity: 100, unit: 'g' }],
        yield: { servings: 1 },
      });
      await waitFor(
        'recipe nutrients',
        () => record(tablet.store, 'recipe', 'sync-bowl').data?.nutrients?.energyKcal === 71,
      );
      const meal = await api(owner.cookie, 'POST', '/api/v1/meals/from-recipe', {
        operationId: crypto.randomUUID(),
        recipeId: 'sync-bowl',
        occurredAt: '2026-10-20T12:00:00Z',
      });
      expect(meal.data.nutrients.energyKcal).toBe(71);
      await waitFor('meal replica', () => record(phone.store, 'meal', meal.id).row.pending === 0);

      const recipeVersion = Number(phone.store.getRow('recipe', 'sync-bowl').version);
      stageSyncChange(
        phone.store,
        'recipe',
        'sync-bowl',
        {
          name: 'Oat bowl',
          ingredients: [{ id: 'oats', foodId: 'sync-oats', quantity: 50, unit: 'g' }],
          yield: { servings: 1 },
        },
        recipeVersion,
      );
      await waitFor(
        'revised recipe',
        () => record(tablet.store, 'recipe', 'sync-bowl').data?.nutrients?.energyKcal === 35.5,
      );
      const mealAfter = await api(owner.cookie, 'GET', '/api/v1/meals/' + meal.id);
      expect(mealAfter.data.nutrients.energyKcal).toBe(71);

      await api(owner.cookie, 'POST', '/api/v1/foods', {
        operationId: crypto.randomUUID(),
        id: 'sync-oats',
        expectedVersion: 1,
        data: { ...oats, name: 'Renamed oats' },
      });
      await waitFor(
        'renamed food',
        () => record(phone.store, 'food', 'sync-oats').data?.name === 'Renamed oats',
      );
      stageSyncChange(phone.store, 'food', 'sync-oats', { ...oats, name: 'Stale oats' }, 1);
      await waitFor(
        'stale edit rejected',
        () =>
          phone.store.getRow('food', 'sync-oats').error === 'VERSION_CONFLICT' &&
          record(phone.store, 'food', 'sync-oats').data?.name === 'Renamed oats',
      );
      const conflict = phone.store
        .getRowIds('conflicts')
        .map((id) => phone.store.getRow('conflicts', id))
        .find((row) => row.recordId === 'sync-oats' && row.code === 'VERSION_CONFLICT');
      expect(conflict?.body).toContain('Stale oats');
      const current = await api(owner.cookie, 'GET', '/api/v1/foods/sync-oats');
      expect(current.version).toBe(2);

      const mealVersion = Number(phone.store.getRow('meal', meal.id).version);
      stageSyncChange(phone.store, 'meal', meal.id, { notes: 'tampered' }, mealVersion);
      await waitFor(
        'meal edit rejected',
        () => phone.store.getRow('meal', meal.id).error === 'SYNC_READ_ONLY',
      );
      expect(record(phone.store, 'meal', meal.id).data?.nutrients?.energyKcal).toBe(71);
      expect((await api(owner.cookie, 'GET', '/api/v1/meals/' + meal.id)).version).toBe(
        meal.version,
      );
    } finally {
      await Promise.all(
        [phone.stop(), tablet.stop(), stranger.stop()].map((done) => done.catch(() => undefined)),
      );
    }
  });
});
