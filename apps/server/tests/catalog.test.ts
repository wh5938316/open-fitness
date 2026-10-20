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
    expect(result?.nutrients.energyKcal).toBe(123);
    expect(result?.nutrients.carbohydrateG).toBeNull();
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
});
