import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { KVCache } from '../src/adapters/cloudflare';
import { OpenFoodFacts } from '../src/adapters/open-food-facts';

describe('Open Food Facts adapter', () => {
  it('sets an application identifier, preserves missing nutrients, and caches label snapshots', async () => {
    let calls = 0;
    const client = new OpenFoodFacts(
      new KVCache(env.CACHE),
      'OpenFitness/test (self-hosted)',
      async (_url, init) => {
        calls++;
        expect(new Headers(init?.headers).get('User-Agent')).toContain('OpenFitness');
        return Response.json({
          product: {
            product_name: 'Example product',
            nutriments: { 'energy-kcal_100g': 123, proteins_100g: 5 },
          },
        });
      },
    );
    const result = await client.lookup('1111111111111');
    expect(result?.food.nutrients.energyKcal).toBe(123);
    expect(result?.food.nutrients.carbohydrateG).toBeNull();
    expect(result?.food.barcode).toBe('1111111111111');
    expect(result?.food.source.kind).toBe('open_food_facts');
    expect(await client.lookup('1111111111111')).toEqual(result);
    expect(calls).toBe(1);
  });
  it('reports upstream outages, rate limits, and absent products without substituting zero calories', async () => {
    const cache = new KVCache(env.CACHE);
    const failing = new OpenFoodFacts(
      cache,
      'OpenFitness/test',
      async () => new Response(null, { status: 503 }),
    );
    await expect(failing.lookup('2222222222222')).rejects.toMatchObject({
      code: 'FOOD_CATALOG_UNAVAILABLE',
    });
    const limited = new OpenFoodFacts(
      cache,
      'OpenFitness/test',
      async () => new Response(null, { status: 429 }),
    );
    await expect(limited.lookup('3333333333333')).rejects.toMatchObject({
      code: 'FOOD_CATALOG_RATE_LIMITED',
    });
    const absent = new OpenFoodFacts(
      cache,
      'OpenFitness/test',
      async () => new Response(null, { status: 404 }),
    );
    expect(await absent.lookup('4444444444444')).toBeNull();
  });
  it('prefers search-a-licious hits and falls back to cgi search when that host fails', async () => {
    const urls: string[] = [];
    const client = new OpenFoodFacts(new KVCache(env.CACHE), 'OpenFitness/test', async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('https://search.openfoodfacts.org/search'))
        return new Response('unavailable', { status: 503 });
      expect(url).toContain('/cgi/search.pl');
      expect(url).toContain('search_terms=oat');
      return Response.json({
        products: [
          {
            code: '123456789012',
            product_name: 'Oat drink',
            brands: ['Oatly'],
            nutriments: { 'energy-kcal_100g': 45 },
            last_modified_t: 1700000000,
          },
        ],
      });
    });
    const items = await client.search('oat');
    expect(items).toHaveLength(1);
    expect(items[0]?.food.barcode).toBe('0123456789012');
    expect(items[0]?.brands).toBe('Oatly');
    expect(items[0]?.food.source.upstreamModifiedAt).toBe(
      new Date(1700000000 * 1000).toISOString(),
    );
    expect(urls.some((url) => url.startsWith('https://search.openfoodfacts.org/search?'))).toBe(
      true,
    );
    const direct = new OpenFoodFacts(new KVCache(env.CACHE), 'OpenFitness/test', async (input) => {
      const url = String(input);
      expect(url).toContain('https://search.openfoodfacts.org/search?');
      expect(url).toContain('page_size=10');
      expect(url).toContain('fields=code');
      return Response.json({
        hits: [
          {
            code: '3017620422003',
            product_name: 'Spread',
            brands: ['Nutella', 'Ferrero'],
            nutriments: { 'energy-kj_100g': 2250 },
          },
        ],
      });
    });
    const hits = await direct.search('spread');
    expect(hits[0]?.food.barcode).toBe('3017620422003');
    expect(hits[0]?.brands).toBe('Nutella, Ferrero');
    expect(hits[0]?.food.nutrients.energyKcal).toBeCloseTo(2250 / 4.184, 5);
    expect(urls.filter((url) => url.includes('/cgi/search.pl'))).toHaveLength(1);
  });
  it('does not call cgi search when search-a-licious rate limits the request', async () => {
    const urls: string[] = [];
    const client = new OpenFoodFacts(new KVCache(env.CACHE), 'OpenFitness/test', async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 429 });
    });
    await expect(client.search('rate-limit-token')).rejects.toMatchObject({
      code: 'FOOD_CATALOG_RATE_LIMITED',
    });
    expect(urls).toEqual([expect.stringContaining('https://search.openfoodfacts.org/search?')]);
  });
});
