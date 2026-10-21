import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'http://localhost:18787';

function food(name: string, code: string, kcal: number) {
  return {
    name,
    barcode: code,
    nutrients: { energyKcal: kcal },
    basis: { quantity: 100, unit: 'g' },
    source: {
      kind: 'open_food_facts',
      reference: `https://world.openfoodfacts.org/product/${code}`,
    },
  };
}

test('adopts cached catalog products into the signed-in owner foods', async ({ request }) => {
  const minted = await request.post('/__test/clerk-token', {
    data: { sub: 'user_catalog_e2e', sid: 'sess_catalog_e2e' },
  });
  expect(minted.status()).toBe(200);
  const token = (await minted.json()).data.token as string;
  const exchanged = await request.post('/auth/clerk/session', {
    headers: { Origin: origin, Authorization: 'Bearer ' + token },
    data: {},
  });
  expect(exchanged.status()).toBe(200);
  const headers = { Origin: origin };

  const ean = '0123456789055';
  const other = '4000000000004';
  const fresh = new Date().toISOString();
  const seeded = await request.put('/__test/food-catalog', {
    data: {
      forceStatus: null,
      product: { code: ean, brands: 'E2E', fetchedAt: fresh, food: food('E2E oats', ean, 80) },
    },
  });
  expect(seeded.status()).toBe(200);
  expect(
    (
      await request.put('/__test/food-catalog', {
        data: {
          product: {
            code: other,
            brands: 'E2E',
            fetchedAt: fresh,
            food: food('E2E beans', other, 90),
          },
        },
      })
    ).status(),
  ).toBe(200);

  const importFood = (barcode: string) =>
    request.post('/api/v1/foods/import', {
      headers,
      data: { operationId: randomUUID(), barcode },
    });
  const first = await importFood(ean.slice(1));
  expect(first.status()).toBe(200);
  const created = (await first.json()).data;
  expect(created.created).toBe(true);
  expect(created.food.data.barcode).toBe(ean);
  const second = await importFood(ean);
  expect(second.status()).toBe(200);
  const existing = (await second.json()).data;
  expect(existing.created).toBe(false);
  expect(existing.food.id).toBe(created.food.id);

  const concurrentCode = '0123456789062';
  expect(
    (
      await request.put('/__test/food-catalog', {
        data: {
          product: {
            code: concurrentCode,
            fetchedAt: fresh,
            food: food('E2E concurrent', concurrentCode, 11),
          },
        },
      })
    ).status(),
  ).toBe(200);
  const raced = await Promise.all([
    importFood(concurrentCode),
    importFood(concurrentCode.slice(1)),
  ]);
  expect(raced.every((response) => response.status() === 200 || response.status() === 409)).toBe(
    true,
  );
  const racedAgain = await importFood(concurrentCode);
  expect(racedAgain.status()).toBe(200);
  expect((await racedAgain.json()).data.created).toBe(false);

  const edited = await request.post('/api/v1/foods', {
    headers,
    data: {
      operationId: randomUUID(),
      id: created.food.id,
      expectedVersion: created.food.version,
      data: {
        ...created.food.data,
        nutrients: { ...created.food.data.nutrients, energyKcal: 1 },
      },
    },
  });
  expect(edited.status()).toBe(200);
  const userFood = (await edited.json()).data;
  expect(userFood.data.source.kind).toBe('user');
  const blocked = await request.post(`/api/v1/foods/${created.food.id}/refresh`, {
    headers,
    data: {
      operationId: randomUUID(),
      expectedVersion: userFood.version,
      mode: 'if_unmodified',
    },
  });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).error.code).toBe('FOOD_MODIFIED');

  expect(
    (
      await request.put('/__test/food-catalog', {
        data: {
          forceStatus: 'fixture',
          fixture: { code: ean, name: 'E2E oats refreshed', kcal: 77 },
        },
      })
    ).status(),
  ).toBe(200);
  const overwritten = await request.post(`/api/v1/foods/${created.food.id}/refresh`, {
    headers,
    data: {
      operationId: randomUUID(),
      expectedVersion: userFood.version,
      mode: 'overwrite',
    },
  });
  expect(overwritten.status()).toBe(200);
  const refreshed = (await overwritten.json()).data;
  expect(refreshed.data.source.kind).toBe('open_food_facts');
  expect(refreshed.data.nutrients.energyKcal).toBe(77);

  const staleCode = '5000000000005';
  expect(
    (
      await request.put('/__test/food-catalog', {
        data: {
          forceStatus: '503',
          product: {
            code: staleCode,
            fetchedAt: '2020-01-01T00:00:00.000Z',
            food: food('E2E stale', staleCode, 5),
          },
        },
      })
    ).status(),
  ).toBe(200);
  const lookup = await request.get(`/api/v1/food-catalog/${staleCode}`);
  expect(lookup.status()).toBe(200);
  const lookedUp = (await lookup.json()).data;
  expect(lookedUp.stale).toBe(true);
  expect(lookedUp.catalogStatus).toBe('degraded');
  const search = await request.get('/api/v1/foods?query=E2E&includeCatalog=true&limit=30');
  expect(search.status()).toBe(200);
  const page = (await search.json()).data;
  expect(page.catalog.catalogStatus).toBe('degraded');
  const catalogCodes = page.catalog.items.map((item: { barcode: string }) => item.barcode);
  expect(catalogCodes).toContain(other);
  expect(catalogCodes).not.toContain(ean);
  expect(catalogCodes).not.toContain(concurrentCode);

  const calculatedCode = '6000000000006';
  expect(
    (
      await request.put('/__test/food-catalog', {
        data: {
          forceStatus: null,
          product: {
            code: calculatedCode,
            fetchedAt: fresh,
            food: food('E2E calculated', calculatedCode, 40),
          },
        },
      })
    ).status(),
  ).toBe(200);
  const calculated = await request.post('/api/v1/nutrition/calculate', {
    headers,
    data: { ingredients: [{ catalogBarcode: calculatedCode, quantity: 50, unit: 'g' }] },
  });
  expect(calculated.status()).toBe(200);
  expect((await calculated.json()).data.nutrients.energyKcal).toBe(20);
  const absent = await request.get(
    `/api/v1/foods?query=${calculatedCode}&includeCatalog=false&limit=30`,
  );
  expect((await absent.json()).data.items).toHaveLength(0);

  const logged = await request.post('/api/v1/meals', {
    headers,
    data: {
      operationId: randomUUID(),
      occurredAt: '2026-10-21T15:00:00Z',
      ingredients: [{ catalogBarcode: calculatedCode, quantity: 100, unit: 'g' }],
    },
  });
  expect(logged.status()).toBe(200);
  const meal = (await logged.json()).data;
  expect(meal.adoptedFoods).toHaveLength(1);
  expect(meal.data.ingredients[0].foodId).toBe(meal.adoptedFoods[0].id);
  const saved = await request.get(
    `/api/v1/foods?query=${calculatedCode}&includeCatalog=false&limit=30`,
  );
  expect((await saved.json()).data.items).toHaveLength(1);
});
