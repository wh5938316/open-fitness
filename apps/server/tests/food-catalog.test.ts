import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createFoodCatalog } from '../src/adapters/cached-food-catalog';
import { D1FoodCatalogStore } from '../src/adapters/d1-food-catalog';
import { D1Repository } from '../src/adapters/cloudflare';
import { CATALOG_TTL_MS } from '../src/domain/catalog';
import { FitnessService } from '../src/domain/service';
import { foodSchema, ingredientSchema, type Food } from '../src/domain/schemas';
import type { Actor, Commit, Entity } from '../src/types';

const op = () => crypto.randomUUID();
const actor = (ownerId = 'owner'): Actor => ({
  ownerId,
  id: ownerId,
  kind: 'owner',
  locale: 'en',
  timeZone: 'America/New_York',
});

function digits(length: number): string {
  let value = '';
  while (value.length < length) value += Math.floor(Math.random() * 10).toString();
  return value.slice(0, length);
}

function productBody(code: string, name: string, kcal: number) {
  return {
    code,
    product_name: name,
    brands: 'Cache Brand',
    nutriments: { 'energy-kcal_100g': kcal, proteins_100g: 2 },
    last_modified_t: 1700000000,
  };
}

function harness(handler: (url: string) => Response | Promise<Response>, ownerId = 'owner') {
  const calls: string[] = [];
  const catalog = createFoodCatalog(
    env,
    async (input) => {
      const url = String(input);
      calls.push(url);
      return handler(url);
    },
    { lookup: 1000, search: 1000 },
  );
  const repository = new D1Repository(env.DB);
  const service = new FitnessService(repository, actor(ownerId), catalog);
  return { calls, catalog, repository, service };
}

async function countFoods(ownerId: string, barcode: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM documents
     WHERE owner_id=? AND kind='food' AND deleted=0 AND json_extract(data, '$.barcode')=?`,
  )
    .bind(ownerId, barcode)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

beforeEach(async () => {
  await env.CACHE.delete('off:search:cooldown');
});

describe('food catalog adoption', () => {
  it('imports a barcode once, including the 12-digit and 13-digit forms', async () => {
    const ean = `0${digits(12)}`;
    const upc = ean.slice(1);
    const { calls, service } = harness(async (url) => {
      expect(url).toContain(`/api/v3/product/${ean}`);
      return Response.json({ product: productBody(ean, 'Imported oats', 81) });
    });
    const first = (await service.execute('import_food', { operationId: op(), barcode: upc })) as {
      food: Entity<Food>;
      created: boolean;
    };
    expect(first.created).toBe(true);
    expect(first.food.data.barcode).toBe(ean);
    expect(first.food.data.source.kind).toBe('open_food_facts');
    expect(first.food.data.source.retrievedAt).toBeTruthy();
    const second = (await service.execute('import_food', {
      operationId: op(),
      barcode: ean,
    })) as { food: Entity<Food>; created: boolean };
    expect(second.created).toBe(false);
    expect(second.food.id).toBe(first.food.id);
    expect(second.food.version).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await countFoods('owner', ean)).toBe(1);
  });

  it('keeps one food when the same barcode is imported concurrently', async () => {
    const ean = `0${digits(12)}`;
    const { service } = harness(async () =>
      Response.json({ product: productBody(ean, 'Concurrent oats', 82) }),
    );
    const settled = await Promise.allSettled([
      service.execute('import_food', { operationId: op(), barcode: ean }),
      service.execute('import_food', { operationId: op(), barcode: ean.slice(1) }),
    ]);
    expect(settled.some((item) => item.status === 'fulfilled')).toBe(true);
    expect(await countFoods('owner', ean)).toBe(1);
    const again = (await service.execute('import_food', {
      operationId: op(),
      barcode: ean,
    })) as { food: Entity<Food>; created: boolean };
    expect(again.created).toBe(false);
    const row = await env.DB.prepare(
      `SELECT id FROM documents WHERE owner_id='owner' AND kind='food' AND deleted=0 AND json_extract(data, '$.barcode')=?`,
    )
      .bind(ean)
      .first<{ id: string }>();
    expect(again.food.id).toBe(row?.id);
  });

  it('serves a stale catalog row when upstream fails and hides owned barcodes from catalog search', async () => {
    const owned = `8${digits(12)}`;
    const other = `7${digits(12)}`;
    const token = `stale-${digits(8)}`;
    const store = new D1FoodCatalogStore(env.DB);
    const staleFood = foodSchema.parse({
      name: `${token} owned`,
      barcode: owned,
      nutrients: { energyKcal: 11 },
      basis: { quantity: 100, unit: 'g' },
      source: {
        kind: 'open_food_facts',
        reference: `https://world.openfoodfacts.org/product/${owned}`,
      },
    });
    const otherFood = foodSchema.parse({
      ...staleFood,
      name: `${token} other`,
      barcode: other,
      source: {
        kind: 'open_food_facts',
        reference: `https://world.openfoodfacts.org/product/${other}`,
      },
    });
    const fetchedAt = new Date(Date.now() - CATALOG_TTL_MS - 86_400_000).toISOString();
    await store.upsert({
      code: owned,
      productName: staleFood.name,
      brands: 'Old',
      food: { ...staleFood, source: { ...staleFood.source, retrievedAt: fetchedAt } },
      upstreamModifiedAt: null,
      fetchedAt,
    });
    await store.upsert({
      code: other,
      productName: otherFood.name,
      brands: 'Old',
      food: { ...otherFood, source: { ...otherFood.source, retrievedAt: fetchedAt } },
      upstreamModifiedAt: null,
      fetchedAt,
    });
    const { service } = harness(async () => new Response(null, { status: 503 }));
    const imported = (await service.execute('import_food', {
      operationId: op(),
      barcode: owned,
    })) as { created: boolean; stale?: boolean; food: Entity<Food> };
    expect(imported.created).toBe(true);
    expect(imported.stale).toBe(true);
    const lookup = (await service.execute('lookup_food', { barcode: other })) as {
      food: Food;
      stale: boolean;
      catalogStatus?: string;
      localFood: null;
    };
    expect(lookup.stale).toBe(true);
    expect(lookup.catalogStatus).toBe('degraded');
    expect(lookup.food.barcode).toBe(other);
    expect(lookup.localFood).toBeNull();
    const page = (await service.execute('search_foods', {
      query: token,
      includeCatalog: true,
    })) as { items: Entity<Food>[]; catalog: { items: Food[]; catalogStatus: string } };
    expect(page.items.map((item) => item.data.barcode)).toEqual([owned]);
    expect(page.catalog.catalogStatus).toBe('degraded');
    expect(page.catalog.items.map((item) => item.barcode)).toEqual([other]);
    const catalog = (await service.execute('search_food_catalog', { query: token })) as {
      catalogStatus: string;
      items: Food[];
    };
    expect(catalog.catalogStatus).toBe('degraded');
    expect(catalog.items.length).toBeGreaterThan(0);
  });

  it('cools down after upstream 429 and then searches only the local catalog', async () => {
    const code = `6${digits(12)}`;
    const token = `cool-${digits(8)}`;
    let calls = 0;
    const { service } = harness(async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          hits: [productBody(code, `${token} biscuit`, 33)],
        });
      }
      return new Response(null, { status: 429 });
    });
    const first = (await service.execute('search_food_catalog', { query: token })) as {
      catalogStatus: string;
      items: Food[];
    };
    expect(first.catalogStatus).toBe('ok');
    expect(first.items[0]?.barcode).toBe(code);
    const limited = (await service.execute('search_food_catalog', { query: `${token}-miss` })) as {
      catalogStatus: string;
    };
    expect(limited.catalogStatus).toBe('degraded');
    const cooled = (await service.execute('search_food_catalog', { query: token })) as {
      catalogStatus: string;
      items: Food[];
    };
    expect(cooled.catalogStatus).toBe('degraded');
    expect(cooled.items.some((item) => item.barcode === code)).toBe(true);
    expect(calls).toBe(2);
  });

  it('flips nutrient edits to user data and enforces refresh modes', async () => {
    const code = `5${digits(12)}`;
    let kcal = 40;
    const { service } = harness(async () =>
      Response.json({ product: productBody(code, 'Label yogurt', kcal) }),
    );
    const imported = (await service.execute('import_food', {
      operationId: op(),
      barcode: code,
    })) as { food: Entity<Food> };
    const renamed = (await service.execute('save_food', {
      operationId: op(),
      id: imported.food.id,
      expectedVersion: imported.food.version,
      data: { ...imported.food.data, name: 'My yogurt', aliases: ['breakfast'], notes: 'keep me' },
    })) as Entity<Food>;
    expect(renamed.data.source.kind).toBe('open_food_facts');
    const edited = (await service.execute('save_food', {
      operationId: op(),
      id: renamed.id,
      expectedVersion: renamed.version,
      data: {
        ...renamed.data,
        nutrients: { ...renamed.data.nutrients, energyKcal: 1 },
      },
    })) as Entity<Food>;
    expect(edited.data.source.kind).toBe('user');
    expect(edited.data.barcode).toBe(code);
    expect(edited.data.source.reference).toContain(code);
    await expect(
      service.execute('refresh_food', {
        operationId: op(),
        id: edited.id,
        expectedVersion: edited.version,
        mode: 'if_unmodified',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'FOOD_MODIFIED' });
    kcal = 55;
    const overwritten = (await service.execute('refresh_food', {
      operationId: op(),
      id: edited.id,
      expectedVersion: edited.version,
      mode: 'overwrite',
    })) as Entity<Food>;
    expect(overwritten.data.source.kind).toBe('open_food_facts');
    expect(overwritten.data.nutrients.energyKcal).toBe(55);
    expect(overwritten.data.aliases).toEqual(['breakfast']);
    expect(overwritten.data.notes).toBe('keep me');
    expect(overwritten.version).toBe(edited.version + 1);
    await expect(
      service.execute('refresh_food', {
        operationId: op(),
        id: overwritten.id,
        expectedVersion: overwritten.version - 1,
        mode: 'if_unmodified',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });

  it('refreshes stale catalog rows that foods reference and leaves those foods unchanged', async () => {
    const referenced = `4${digits(12)}`;
    const ignored = `3${digits(12)}`;
    const { catalog, service } = harness(async (url) => {
      const match = url.match(/\/product\/([^?]+)/);
      const code = match?.[1] ? decodeURIComponent(match[1]) : referenced;
      return Response.json({
        product: productBody(code, 'Refreshed label', code === referenced ? 70 : 10),
      });
    });
    const saved = (await service.execute('save_food', {
      operationId: op(),
      data: foodSchema.parse({
        name: 'Library copy',
        barcode: referenced,
        nutrients: { energyKcal: 10 },
        basis: { quantity: 100, unit: 'g' },
        source: {
          kind: 'open_food_facts',
          reference: `https://world.openfoodfacts.org/product/${referenced}`,
        },
      }),
    })) as Entity<Food>;
    const store = new D1FoodCatalogStore(env.DB);
    const old = new Date(Date.now() - CATALOG_TTL_MS - 1000).toISOString();
    const stale = (code: string, name: string) => {
      const food = foodSchema.parse({
        name,
        barcode: code,
        nutrients: { energyKcal: 10 },
        basis: { quantity: 100, unit: 'g' },
        source: {
          kind: 'open_food_facts',
          reference: `https://world.openfoodfacts.org/product/${code}`,
          retrievedAt: old,
        },
      });
      return store.upsert({
        code,
        productName: name,
        brands: null,
        food,
        upstreamModifiedAt: null,
        fetchedAt: old,
      });
    };
    await stale(referenced, 'Old referenced');
    await stale(ignored, 'Old ignored');
    await catalog.refreshStale();
    const current = (await service.execute('get_food', { id: saved.id })) as Entity<Food>;
    expect(current.version).toBe(saved.version);
    expect(current.data.nutrients.energyKcal).toBe(10);
    expect(current.data.name).toBe('Library copy');
    expect((await store.get(referenced))?.food.nutrients.energyKcal).toBe(70);
    expect((await store.get(ignored))?.fetchedAt).toBe(old);
  });

  it('adopts a catalog barcode in the same transaction as a meal, recipe, or calculation', async () => {
    const code = `2${digits(12)}`;
    const { repository, service } = harness(async () =>
      Response.json({ product: productBody(code, 'Atomic beans', 90) }),
    );
    const before = await countFoods('owner', code);
    const calculated = (await service.execute('calculate_nutrition', {
      ingredients: [{ catalogBarcode: code, quantity: 50, unit: 'g' }],
    })) as { ingredients: { foodId?: string }[]; nutrients: { energyKcal: number } };
    expect(calculated.nutrients.energyKcal).toBe(45);
    expect(calculated.ingredients[0]?.foodId).toBeUndefined();
    expect(await countFoods('owner', code)).toBe(before);

    const meal = (await service.execute('log_meal', {
      operationId: op(),
      occurredAt: '2026-10-21T12:00:00Z',
      ingredients: [{ catalogBarcode: code, quantity: 100, unit: 'g' }],
    })) as Entity<{ ingredients: { foodId?: string }[] }> & { adoptedFoods?: Entity<Food>[] };
    expect(meal.adoptedFoods).toHaveLength(1);
    expect(meal.data.ingredients[0]?.foodId).toBe(meal.adoptedFoods?.[0]?.id);
    const repeat = (await service.execute('log_meal', {
      operationId: op(),
      occurredAt: '2026-10-21T13:00:00Z',
      ingredients: [{ catalogBarcode: code, quantity: 10, unit: 'g' }],
    })) as { adoptedFoods?: Entity<Food>[] };
    expect(repeat.adoptedFoods).toBeUndefined();

    const recipeCode = `1${digits(12)}`;
    const recipeService = harness(async () =>
      Response.json({ product: productBody(recipeCode, 'Atomic rice', 100) }),
    ).service;
    const recipe = (await recipeService.execute('save_recipe', {
      operationId: op(),
      data: {
        name: `Atomic ${recipeCode}`,
        ingredients: [
          { id: 'a', catalogBarcode: recipeCode, quantity: 10, unit: 'g' },
          { id: 'b', catalogBarcode: recipeCode, quantity: 15, unit: 'g' },
        ],
        yield: { servings: 1 },
      },
    })) as Entity<{ ingredients: { foodId?: string }[] }> & { adoptedFoods?: Entity<Food>[] };
    expect(recipe.adoptedFoods).toHaveLength(1);
    expect(recipe.data.ingredients[0]?.foodId).toBe(recipe.data.ingredients[1]?.foodId);

    const failing = new D1Repository(env.DB);
    failing.commit = async () => {
      throw new Error('forced commit failure');
    };
    const failedCode = `9${digits(12)}`;
    const failed = new FitnessService(
      failing,
      actor(),
      createFoodCatalog(
        env,
        async () => Response.json({ product: productBody(failedCode, 'Rollback soup', 12) }),
        { lookup: 1000, search: 1000 },
      ),
    );
    await expect(
      failed.execute('log_meal', {
        operationId: op(),
        occurredAt: '2026-10-21T14:00:00Z',
        ingredients: [{ catalogBarcode: failedCode, quantity: 100, unit: 'g' }],
      }),
    ).rejects.toThrow('forced commit failure');
    expect(await countFoods('owner', failedCode)).toBe(0);
    const leaked = await env.DB.prepare(
      `SELECT id FROM documents WHERE kind='meal' AND data LIKE ?`,
    )
      .bind('%Rollback soup%')
      .all();
    expect(leaked.results).toHaveLength(0);

    const now = new Date().toISOString();
    const duplicate = `0${digits(12)}`;
    const entity = (id: string): Entity<Food> => ({
      id,
      kind: 'food',
      version: 1,
      createdAt: now,
      updatedAt: now,
      data: foodSchema.parse({
        name: id,
        barcode: duplicate,
        nutrients: { energyKcal: 1 },
        basis: { quantity: 100, unit: 'g' },
        source: {
          kind: 'open_food_facts',
          reference: `https://world.openfoodfacts.org/product/${duplicate}`,
        },
      }),
    });
    const input: Commit = {
      actor: actor(),
      operation: 'import_food',
      operationId: op(),
      requestHash: op(),
      response: { ok: false },
      mutations: [
        { entity: entity('food-a-' + duplicate) },
        { entity: entity('food-b-' + duplicate) },
      ],
    };
    await expect(repository.commit(input)).rejects.toMatchObject({ code: 'FOOD_BARCODE_EXISTS' });
    expect(await countFoods('owner', duplicate)).toBe(0);
  });

  it('searches foods by name, alias, and barcode without matching notes', async () => {
    const token = `narrow-${digits(8)}`;
    const code = `8${digits(7)}`;
    const { service } = harness(async () => new Response(null, { status: 503 }));
    await service.execute('save_food', {
      operationId: op(),
      data: {
        name: `Visible ${token}`,
        aliases: [`alias-${token}`],
        barcode: code,
        notes: `secret-${token}`,
        nutrients: { energyKcal: 5 },
        basis: { quantity: 100, unit: 'g' },
        source: { kind: 'user' },
      },
    });
    const search = (query: string) =>
      service.execute('search_foods', { query, includeCatalog: false }) as Promise<{
        items: Entity<Food>[];
        catalog?: unknown;
      }>;
    expect((await search(`secret-${token}`)).items).toHaveLength(0);
    expect((await search(`Visible ${token}`)).items).toHaveLength(1);
    expect((await search(`alias-${token}`)).items).toHaveLength(1);
    expect((await search(code)).items).toHaveLength(1);
    expect((await search(`Visible ${token}`)).catalog).toBeUndefined();
  });

  it('derives a stored barcode from an older Open Food Facts reference', () => {
    const food = foodSchema.parse({
      name: 'Legacy product',
      nutrients: { energyKcal: 1 },
      basis: { quantity: 100, unit: 'g' },
      source: {
        kind: 'open_food_facts',
        reference: 'https://world.openfoodfacts.org/product/123456789012',
      },
    });
    expect(food.barcode).toBe('0123456789012');
    expect(
      foodSchema.safeParse({
        name: 'No code',
        nutrients: {},
        basis: { quantity: 100, unit: 'g' },
        source: { kind: 'open_food_facts' },
      }).success,
    ).toBe(false);
    expect(
      foodSchema.parse({
        name: 'Manual',
        barcode: null,
        nutrients: {},
        basis: { quantity: 100, unit: 'g' },
        source: { kind: 'user', reference: null, basis: null },
      }).barcode,
    ).toBeUndefined();
    const ingredient = ingredientSchema.parse({
      foodId: null,
      catalogBarcode: null,
      label: null,
      quantity: 1,
      unit: 'g',
      food: {
        name: 'Manual',
        nutrients: {},
        basis: { quantity: 100, unit: 'g' },
        source: { kind: 'user', reference: null },
      },
    });
    expect(ingredient.foodId).toBeUndefined();
    expect(ingredient.catalogBarcode).toBeUndefined();
    expect(ingredient.food?.name).toBe('Manual');
  });

  it('keeps the same barcode in separate owner libraries and shares the catalog cache', async () => {
    const ownerId = 'user-catalog-' + digits(8);
    await env.DB.prepare("INSERT OR IGNORE INTO owners(id,status,created_at) VALUES(?,'active',?)")
      .bind(ownerId, Date.now())
      .run();
    const code = `4${digits(12)}`;
    let calls = 0;
    const fetchProduct = async () => {
      calls += 1;
      return Response.json({ product: productBody(code, 'Shared cache beans', 15) });
    };
    const first = harness(fetchProduct);
    const second = harness(fetchProduct, ownerId);
    const owned = (await first.service.execute('import_food', {
      operationId: op(),
      barcode: code,
    })) as { food: Entity<Food> };
    const other = (await second.service.execute('import_food', {
      operationId: op(),
      barcode: code,
    })) as { food: Entity<Food>; created: boolean };
    expect(other.created).toBe(true);
    expect(other.food.id).not.toBe(owned.food.id);
    expect(calls).toBe(1);
    const visible = (await first.service.execute('search_foods', {
      query: code,
      includeCatalog: false,
    })) as { items: Entity<Food>[] };
    expect(visible.items.map((item) => item.id)).toEqual([owned.food.id]);
    await expect(
      first.service.execute('save_food', {
        operationId: op(),
        data: {
          name: 'Duplicate barcode',
          barcode: code,
          nutrients: { energyKcal: 1 },
          basis: { quantity: 100, unit: 'g' },
          source: { kind: 'user' },
        },
      }),
    ).rejects.toMatchObject({ code: 'FOOD_BARCODE_EXISTS' });
  });
});
