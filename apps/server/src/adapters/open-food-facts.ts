import { AppError } from '../errors';
import { sha256 } from '../crypto';
import type { CacheStore } from '../types';
import type { FoodCatalog } from '../domain/service';
import { foodSchema, type Food } from '../domain/schemas';

export class OpenFoodFacts implements FoodCatalog {
  constructor(
    private cache: CacheStore,
    private userAgent: string,
    private request: typeof fetch = fetch,
  ) {}
  private async read(path: string, category: 'lookup' | 'search'): Promise<any> {
    const key = 'off:' + (await sha256(path));
    const cached = await this.cache.get<{ data: unknown }>(key);
    if (cached) return cached.data;
    const window = Math.floor(Date.now() / 60000);
    const rateKey = `off:rate:${category}:${window}`;
    const count = (await this.cache.get<number>(rateKey)) ?? 0;
    if (count >= (category === 'lookup' ? 14 : 9))
      throw new AppError(429, 'FOOD_CATALOG_RATE_LIMITED', 'rateLimited');
    await this.cache.put(rateKey, count + 1, 120);
    let response: Response;
    try {
      response = await this.request('https://world.openfoodfacts.org' + path, {
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
  async lookup(barcode: string): Promise<Food | null> {
    const result = await this.read(
      `/api/v3/product/${encodeURIComponent(barcode)}?fields=code,product_name,nutriments,nutrition_data_per,serving_quantity,serving_quantity_unit`,
      'lookup',
    );
    return result?.product ? normalizeProduct(result.product, barcode) : null;
  }
  async search(query: string): Promise<Food[]> {
    const params = new URLSearchParams({
      search_terms: query,
      search_simple: '1',
      action: 'process',
      json: '1',
      page_size: '10',
      fields:
        'code,product_name,nutriments,nutrition_data_per,serving_quantity,serving_quantity_unit',
    });
    const result = await this.read('/cgi/search.pl?' + params.toString(), 'search');
    if (!Array.isArray(result?.products))
      throw new AppError(502, 'INVALID_FOOD_CATALOG_RESPONSE', 'upstreamUnavailable');
    return result.products
      .map((product: any) => normalizeProduct(product, product.code))
      .filter((food: Food | null): food is Food => food !== null);
  }
}
export function normalizeProduct(product: any, code: string): Food | null {
  if (typeof product?.product_name !== 'string' || !product.product_name.trim()) return null;
  const n = product.nutriments ?? {};
  const number = (key: string) =>
    typeof n[key] === 'number' && Number.isFinite(n[key]) && n[key] >= 0 ? n[key] : null;
  const kj = number('energy-kj_100g');
  const servingUnit = product.serving_quantity_unit;
  const result = foodSchema.safeParse({
    name: product.product_name,
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
      reference: `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`,
      basis: 'Product label data from Open Food Facts. Missing values have not been inferred.',
    },
  });
  return result.success ? result.data : null;
}
