import type { Food } from './schemas';

export const CATALOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CATALOG_REFRESH_LIMIT = 20;
export const SEARCH_COOLDOWN_KEY = 'off:search:cooldown';
export const SEARCH_COOLDOWN_SECONDS = 60;

export interface CatalogRecord {
  code: string;
  productName: string;
  brands: string | null;
  food: Food;
  upstreamModifiedAt: string | null;
  fetchedAt: string;
}

export interface FoodCatalogStore {
  get(code: string): Promise<CatalogRecord | null>;
  search(query: string, limit: number): Promise<CatalogRecord[]>;
  upsert(record: CatalogRecord): Promise<void>;
  staleReferenced(olderThan: string, limit: number): Promise<CatalogRecord[]>;
}

export interface CatalogLookup {
  food: Food | null;
  stale: boolean;
}

export interface CatalogSearch {
  items: Food[];
  catalogStatus: 'ok' | 'degraded';
}

export function isCatalogFresh(fetchedAt: string, now = Date.now()): boolean {
  const fetched = Date.parse(fetchedAt);
  return Number.isFinite(fetched) && now - fetched < CATALOG_TTL_MS;
}
