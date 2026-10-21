import { AppError, notFound } from '../errors';
import { KVCache } from './cloudflare';
import { D1FoodCatalogStore } from './d1-food-catalog';
import { OpenFoodFacts, type UpstreamFood, type UpstreamLimits } from './open-food-facts';
import { normalizeBarcode } from '../domain/barcode';
import {
  CATALOG_REFRESH_LIMIT,
  CATALOG_TTL_MS,
  SEARCH_COOLDOWN_KEY,
  SEARCH_COOLDOWN_SECONDS,
  isCatalogFresh,
  type CatalogLookup,
  type CatalogRecord,
  type CatalogSearch,
  type FoodCatalogStore,
} from '../domain/catalog';
import type { Food } from '../domain/schemas';
import type { CacheStore, Env } from '../types';

function stamp(upstream: UpstreamFood, fetchedAt = new Date().toISOString()): CatalogRecord {
  const barcode = upstream.food.barcode;
  if (!barcode) throw new AppError(502, 'INVALID_FOOD_CATALOG_RESPONSE', 'upstreamUnavailable');
  const food: Food = {
    ...upstream.food,
    source: { ...upstream.food.source, retrievedAt: fetchedAt },
  };
  return {
    code: barcode,
    productName: food.name,
    brands: upstream.brands,
    food,
    upstreamModifiedAt: food.source.upstreamModifiedAt ?? null,
    fetchedAt,
  };
}

export class CachedFoodCatalog {
  constructor(
    private upstream: OpenFoodFacts,
    private store: FoodCatalogStore,
    private cache: CacheStore,
  ) {}

  async lookup(barcode: string): Promise<CatalogLookup> {
    const code = normalizeBarcode(barcode);
    if (!code) return { food: null, stale: false };
    const cached = await this.store.get(code);
    if (cached && isCatalogFresh(cached.fetchedAt)) return { food: cached.food, stale: false };
    try {
      const latest = await this.upstream.lookup(code);
      if (!latest) return { food: null, stale: false };
      const stored = stamp(latest);
      await this.store.upsert(stored);
      return { food: stored.food, stale: false };
    } catch (error) {
      if (cached) return { food: cached.food, stale: true };
      throw error;
    }
  }

  async search(query: string): Promise<CatalogSearch> {
    if (await this.cache.get(SEARCH_COOLDOWN_KEY)) return this.degraded(query);
    try {
      const found = await this.upstream.search(query);
      const items: Food[] = [];
      for (const upstream of found) {
        const stored = stamp(upstream);
        await this.store.upsert(stored);
        items.push(stored.food);
      }
      return { items, catalogStatus: 'ok' };
    } catch (error) {
      if (error instanceof AppError && error.status === 429)
        await this.cache.put(SEARCH_COOLDOWN_KEY, true, SEARCH_COOLDOWN_SECONDS);
      if (error instanceof AppError && (error.status === 429 || error.status === 502))
        return this.degraded(query);
      throw error;
    }
  }

  async refresh(barcode: string): Promise<Food> {
    const code = normalizeBarcode(barcode);
    if (!code) throw new AppError(422, 'INVALID_BARCODE', 'invalidBarcode');
    const latest = await this.upstream.lookup(code, { bypassCache: true });
    if (!latest) throw notFound();
    const stored = stamp(latest);
    await this.store.upsert(stored);
    return stored.food;
  }

  async refreshStale(limit = CATALOG_REFRESH_LIMIT): Promise<void> {
    const cutoff = new Date(Date.now() - CATALOG_TTL_MS).toISOString();
    const rows = await this.store.staleReferenced(cutoff, limit);
    for (const row of rows) {
      try {
        const latest = await this.upstream.lookup(row.code, { bypassCache: true });
        if (!latest) continue;
        await this.store.upsert(stamp(latest));
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
        console.error(JSON.stringify({ event: 'catalog_refresh_failed', barcode: row.code, code }));
        if (error instanceof AppError && error.status === 429) return;
      }
    }
  }

  private async degraded(query: string): Promise<CatalogSearch> {
    const rows = await this.store.search(query, 10);
    return { items: rows.map((row) => row.food), catalogStatus: 'degraded' };
  }
}

export function createFoodCatalog(
  env: Env,
  request: typeof fetch = fetch,
  limits?: UpstreamLimits,
): CachedFoodCatalog {
  const cache = new KVCache(env.CACHE);
  return new CachedFoodCatalog(
    new OpenFoodFacts(
      cache,
      env.OFF_USER_AGENT ?? 'OpenFitness/0.1 (self-hosted)',
      request,
      env.CLERK_TEST_MODE === '1',
      limits,
    ),
    new D1FoodCatalogStore(env.DB),
    cache,
  );
}
