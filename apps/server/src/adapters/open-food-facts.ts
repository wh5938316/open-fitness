import { AppError } from '../errors';
import { sha256 } from '../crypto';
import type { CacheStore } from '../types';
import { normalizeBarcode } from '../domain/barcode';
import { foodSchema, type Food } from '../domain/schemas';

const PRODUCT_FIELDS =
  'code,product_name,brands,nutriments,nutrition_data_per,serving_quantity,serving_quantity_unit,last_modified_t';

export interface UpstreamFood {
  food: Food;
  brands: string | null;
}

export interface UpstreamLimits {
  lookup: number;
  search: number;
}

export function brandsText(value: unknown): string | null {
  const parts = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
  const text = parts
    .map((item) => item.trim())
    .filter(Boolean)
    .join(', ')
    .slice(0, 500);
  return text || null;
}

export function normalizeProduct(product: any, code: string): UpstreamFood | null {
  const barcode =
    (typeof product?.code === 'string' ? normalizeBarcode(product.code) : null) ??
    (typeof product?.code === 'number' && Number.isFinite(product.code)
      ? normalizeBarcode(String(Math.trunc(product.code)))
      : null) ??
    normalizeBarcode(code);
  if (!barcode) return null;
  if (typeof product?.product_name !== 'string' || !product.product_name.trim()) return null;
  const n = product.nutriments ?? {};
  const number = (key: string) =>
    typeof n[key] === 'number' && Number.isFinite(n[key]) && n[key] >= 0 ? n[key] : null;
  const kj = number('energy-kj_100g');
  const servingUnit = product.serving_quantity_unit;
  const modified =
    typeof product.last_modified_t === 'number' &&
    Number.isFinite(product.last_modified_t) &&
    product.last_modified_t > 0
      ? new Date(product.last_modified_t * 1000).toISOString()
      : undefined;
  const result = foodSchema.safeParse({
    name: product.product_name.trim().slice(0, 200),
    barcode,
    nutrients: {
      energyKcal: number('energy-kcal_100g') ?? (kj !== null ? kj / 4.184 : null),
      proteinG: number('proteins_100g'),
      carbohydrateG: number('carbohydrates_100g'),
      fatG: number('fat_100g'),
      fiberG: number('fiber_100g'),
    },
    basis: { quantity: 100, unit: product.nutrition_data_per === '100ml' ? 'ml' : 'g' },
    ...(typeof product.serving_quantity === 'number' &&
    product.serving_quantity > 0 &&
    (servingUnit === 'g' || servingUnit === 'ml')
      ? { servingSize: { quantity: product.serving_quantity, unit: servingUnit } }
      : {}),
    source: {
      kind: 'open_food_facts',
      reference: `https://world.openfoodfacts.org/product/${barcode}`,
      basis: 'Product label data from Open Food Facts. Missing values have not been inferred.',
      ...(modified ? { upstreamModifiedAt: modified } : {}),
    },
  });
  return result.success ? { food: result.data, brands: brandsText(product.brands) } : null;
}

export class OpenFoodFacts {
  constructor(
    private cache: CacheStore,
    private userAgent: string,
    private request: typeof fetch = fetch,
    private testMode = false,
    private limits: UpstreamLimits = { lookup: 14, search: 9 },
  ) {}

  private async fetchJson(
    url: string,
    category: 'lookup' | 'search',
    bypassCache = false,
  ): Promise<any> {
    if (this.testMode) {
      const forced = await this.cache.get<string>('off:test:force-status');
      if (forced === '503')
        throw new AppError(502, 'FOOD_CATALOG_UNAVAILABLE', 'upstreamUnavailable');
      if (forced === '429') throw new AppError(429, 'FOOD_CATALOG_RATE_LIMITED', 'rateLimited');
      if (forced === 'fixture') {
        const fixture = await this.cache.get<{ code?: string; name?: string; kcal?: number }>(
          'off:test:fixture',
        );
        if (!fixture?.code || !fixture.name || typeof fixture.kcal !== 'number')
          throw new AppError(502, 'FOOD_CATALOG_UNAVAILABLE', 'upstreamUnavailable');
        const product = {
          code: fixture.code,
          product_name: fixture.name,
          brands: 'Fixture',
          nutriments: { 'energy-kcal_100g': fixture.kcal },
        };
        return url.includes('/search') ? { hits: [product], products: [product] } : { product };
      }
    }
    const key = 'off:' + (await sha256(url));
    if (!bypassCache) {
      const cached = await this.cache.get<{ data: unknown }>(key);
      if (cached) return cached.data;
    }
    const window = Math.floor(Date.now() / 60000);
    const rateKey = `off:rate:${category}:${this.userAgent}:${window}`;
    const count = (await this.cache.get<number>(rateKey)) ?? 0;
    if (count >= this.limits[category])
      throw new AppError(429, 'FOOD_CATALOG_RATE_LIMITED', 'rateLimited');
    await this.cache.put(rateKey, count + 1, 120);
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new AppError(502, 'FOOD_CATALOG_UNAVAILABLE', 'upstreamUnavailable');
    }
    if (response.status === 429)
      throw new AppError(429, 'FOOD_CATALOG_RATE_LIMITED', 'rateLimited');
    if (response.status === 404) return null;
    if (!response.ok) throw new AppError(502, 'FOOD_CATALOG_UNAVAILABLE', 'upstreamUnavailable');
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AppError(502, 'INVALID_FOOD_CATALOG_RESPONSE', 'upstreamUnavailable');
    }
    await this.cache.put(key, { data }, 86400);
    return data;
  }

  async lookup(barcode: string, options?: { bypassCache?: boolean }): Promise<UpstreamFood | null> {
    const code = normalizeBarcode(barcode) ?? barcode;
    const result = await this.fetchJson(
      `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(code)}?fields=${PRODUCT_FIELDS}`,
      'lookup',
      options?.bypassCache,
    );
    return result?.product ? normalizeProduct(result.product, code) : null;
  }

  async search(query: string): Promise<UpstreamFood[]> {
    const alicious = new URL('https://search.openfoodfacts.org/search');
    alicious.searchParams.set('q', query);
    alicious.searchParams.set('page_size', '10');
    alicious.searchParams.set('fields', PRODUCT_FIELDS);
    try {
      const result = await this.fetchJson(alicious.toString(), 'search');
      if (!result || !Array.isArray(result.hits))
        throw new AppError(502, 'INVALID_FOOD_CATALOG_RESPONSE', 'upstreamUnavailable');
      return this.normalizeMany(result.hits);
    } catch (error) {
      if (error instanceof AppError && error.status === 429) throw error;
    }
    const params = new URLSearchParams({
      search_terms: query,
      search_simple: '1',
      action: 'process',
      json: '1',
      page_size: '10',
      fields: PRODUCT_FIELDS,
    });
    const result = await this.fetchJson(
      'https://world.openfoodfacts.org/cgi/search.pl?' + params.toString(),
      'search',
    );
    if (!result || !Array.isArray(result.products))
      throw new AppError(502, 'INVALID_FOOD_CATALOG_RESPONSE', 'upstreamUnavailable');
    return this.normalizeMany(result.products);
  }

  private normalizeMany(products: unknown[]): UpstreamFood[] {
    return products
      .map((product) =>
        normalizeProduct(product, String((product as { code?: unknown })?.code ?? '')),
      )
      .filter((item): item is UpstreamFood => item !== null);
  }
}
