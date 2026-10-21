import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { D1Repository, R2ObjectStore } from '../src/adapters/cloudflare';
import { FitnessService } from '../src/domain/service';
import { dayBounds, foodNutrition } from '../src/domain/nutrition';
import { foodSchema, type Food } from '../src/domain/schemas';
import { en, messages, resolveLocale, zhCN } from '../src/i18n';
import {
  boundedBody,
  cleanupMedia,
  inspectImage,
  MediaService,
  publicImageUrl,
} from '../src/media';
import type { Actor, Entity, Locale } from '../src/types';

const actor = (locale: Locale = 'en'): Actor => ({
  ownerId: 'owner',
  id: 'owner',
  kind: 'owner',
  locale,
  timeZone: 'America/New_York',
});
const service = (locale: Locale = 'en') =>
  new FitnessService(new D1Repository(env.DB), actor(locale), {
    lookup: async () => ({ food: null, stale: false }),
    search: async () => ({ items: [], catalogStatus: 'ok' }),
    refresh: async () => {
      throw new Error('catalog refresh is not configured');
    },
  });
const op = () => crypto.randomUUID();
const food = (name: string, energy: number, protein: number, carbs: number, fat: number): Food =>
  foodSchema.parse({
    name,
    basis: { quantity: 100, unit: 'g' },
    preparation: 'cooked',
    nutrients: { energyKcal: energy, proteinG: protein, carbohydrateG: carbs, fatG: fat },
    source: {
      kind: 'bot_estimate',
      basis: 'Illustrative test fixture; not a dietary recommendation.',
    },
  });
const rice = () => food('Cooked rice', 130, 2.7, 28, 0.3);
const chicken = () => food('Cooked chicken leg', 200, 25, 0, 10);
async function recipe(s: FitnessService): Promise<Entity<any>> {
  return (await s.execute('save_recipe', {
    operationId: op(),
    data: {
      name: 'Shaxian chicken leg rice',
      aliases: ['Chicken rice'],
      restaurant: 'Regular restaurant',
      ingredients: [
        { id: 'rice', food: rice(), quantity: 200, unit: 'g' },
        { id: 'chicken', food: chicken(), quantity: 140, unit: 'g' },
      ],
      yield: { servings: 1 },
    },
  })) as Entity<any>;
}
const imageBytes = () =>
  Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=',
    ),
    (c) => c.charCodeAt(0),
  );

describe('recipe and meal transactions', () => {
  it('logs cooked-weight portions and one-meal additions without editing a recipe', async () => {
    const s = service();
    const original = await recipe(s);
    await expect(
      s.execute('log_meal_from_recipe', {
        operationId: op(),
        recipeId: original.id,
        grams: 170,
        occurredAt: '2026-10-20T16:00:00Z',
      }),
    ).rejects.toMatchObject({
      code: 'MISSING_CONVERSION',
      details: { required: 'yield.cookedWeightGrams' },
    });
    const weighed = (await s.execute('save_recipe', {
      operationId: op(),
      data: { ...original.data, yield: { cookedWeightGrams: 340 } },
    })) as Entity<any>;
    const meal = (await s.execute('log_meal_from_recipe', {
      operationId: op(),
      recipeId: weighed.id,
      grams: 170,
      occurredAt: '2026-10-20T16:00:00Z',
      overrides: [{ ingredientId: 'rice', quantity: 50 }],
      additions: [{ id: 'extra-chicken', food: chicken(), quantity: 25, unit: 'g' }],
    })) as Entity<any>;
    expect(meal.data.nutrients.energyKcal).toBe(255);
    expect(meal.data.recipe.servings).toBe(0.5);
    const revised = (await s.execute('revise_meal', {
      operationId: op(),
      id: meal.id,
      expectedVersion: meal.version,
      overrides: [{ ingredientId: 'chicken', quantity: 0 }],
      additions: [{ id: 'extra-rice', food: rice(), quantity: 30, unit: 'g' }],
    })) as Entity<any>;
    expect(revised.data.nutrients.energyKcal).toBe(154);
    expect(
      ((await s.execute('get_recipe', { id: weighed.id })) as Entity<any>).data.nutrients
        .energyKcal,
    ).toBe(540);
  });
  it('reuses a recipe, applies one-meal overrides, and preserves historical snapshots', async () => {
    const s = service();
    const saved = await recipe(s);
    const meal = (await s.execute('log_meal_from_recipe', {
      operationId: op(),
      recipeId: saved.id,
      occurredAt: '2026-10-20T12:00:00-04:00',
      overrides: [{ ingredientId: 'rice', quantity: 100 }],
    })) as Entity<any>;
    expect(meal.data.nutrients.energyKcal).toBe(410);
    expect(meal.data.ingredients[0].quantity).toBe(100);
    expect(saved.data.perServing.energyKcal).toBe(540);
    const revised = (await s.execute('save_recipe', {
      operationId: op(),
      id: saved.id,
      expectedVersion: saved.version,
      data: {
        ...saved.data,
        ingredients: [
          { id: 'rice', food: rice(), quantity: 100, unit: 'g' },
          { id: 'chicken', food: chicken(), quantity: 140, unit: 'g' },
        ],
      },
    })) as Entity<any>;
    expect(revised.data.nutritionVersion).toBe(2);
    const original = (await s.execute('get_meal', { id: meal.id })) as Entity<any>;
    expect(original.data.recipe.snapshot.ingredients[0].quantity).toBe(200);
    expect(original.data.recipe.version).toBe(1);
    expect(original.data.nutrients.fiberG).toBeNull();
    const fromCachedRecipe = (await s.execute('log_meal_from_recipe', {
      operationId: op(),
      recipeId: saved.id,
      recipeVersion: saved.version,
      servings: 1,
      occurredAt: '2026-10-20T20:00:00Z',
    })) as Entity<any>;
    expect(fromCachedRecipe.data.recipe.version).toBe(saved.version);
    expect(fromCachedRecipe.data.nutrients.energyKcal).toBe(540);
  });
  it('does not duplicate a meal or export event when a request is retried', async () => {
    const s = service();
    const saved = await recipe(s);
    const request = { operationId: op(), recipeId: saved.id, occurredAt: '2026-10-20T16:00:00Z' };
    const first = (await s.execute('log_meal_from_recipe', request)) as Entity<any>;
    expect(await s.execute('log_meal_from_recipe', request)).toEqual(first);
    const events = await env.DB.prepare('SELECT * FROM health_exports WHERE meal_id=?')
      .bind(first.id)
      .all();
    expect(events.results).toHaveLength(1);
    await expect(
      s.execute('log_meal_from_recipe', { ...request, servings: 2 }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('corrects and deletes one meal while retaining revisions and versioned export events', async () => {
    const s = service();
    const saved = await recipe(s);
    const meal = (await s.execute('log_meal_from_recipe', {
      operationId: op(),
      recipeId: saved.id,
      occurredAt: '2026-10-20T16:00:00Z',
    })) as Entity<any>;
    const revised = (await s.execute('revise_meal', {
      operationId: op(),
      id: meal.id,
      expectedVersion: 1,
      overrides: [{ ingredientId: 'rice', quantity: 100 }],
      notes: 'Original user text: 米饭减半',
    })) as Entity<any>;
    expect(revised.data.notes).toContain('米饭减半');
    await s.execute('delete_meal', {
      operationId: op(),
      id: meal.id,
      expectedVersion: revised.version,
    });
    await expect(s.execute('get_meal', { id: meal.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const revisions = await s.repository.revisions('owner', 'meal', meal.id);
    expect(revisions).toHaveLength(3);
    const events = await env.DB.prepare(
      'SELECT action,status FROM health_exports WHERE meal_id=? ORDER BY meal_version',
    )
      .bind(meal.id)
      .all();
    expect(events.results.map((e) => e.action)).toEqual(['upsert', 'upsert', 'delete']);
    expect(events.results.map((e) => e.status)).toEqual([
      'superseded',
      'superseded',
      'awaiting_device',
    ]);
  });
  it('detects concurrent edits and rolls back an entire batch on an outbox constraint failure', async () => {
    const s = service();
    const saved = await recipe(s);
    const updates = await Promise.allSettled(
      [1, 2].map((n) =>
        s.execute('save_recipe', {
          operationId: op(),
          id: saved.id,
          expectedVersion: 1,
          data: { ...saved.data, name: 'Revision ' + n },
        }),
      ),
    );
    expect(updates.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(updates.filter((value) => value.status === 'rejected')).toHaveLength(1);
    const meal = (await s.execute('log_meal_from_recipe', {
      operationId: op(),
      recipeId: saved.id,
      occurredAt: '2026-10-20T16:00:00Z',
    })) as Entity<any>;
    const failingId = op();
    const doc = await s.save('exercise', { name: 'Should roll back' }, {});
    await expect(
      s.repository.commit({
        actor: actor(),
        operation: 'test_atomicity',
        operationId: failingId,
        requestHash: 'hash',
        response: doc,
        mutations: [{ entity: doc }],
        exports: [{ mealId: meal.id, version: 1, action: 'upsert', payload: {} }],
      }),
    ).rejects.toBeDefined();
    expect(await s.repository.get('owner', 'exercise', doc.id)).toBeNull();
    expect(await s.repository.replay('owner', failingId, 'hash')).toBeNull();
  });
});

describe('training snapshots', () => {
  it('keeps planned targets and actual sets independent and permits historical correction', async () => {
    const s = service();
    const exercise = (await s.execute('save_exercise', {
      operationId: op(),
      data: { name: 'Squat' },
    })) as Entity<any>;
    const plan = (await s.execute('save_training_plan', {
      operationId: op(),
      data: {
        name: 'Session A',
        exercises: [{ exerciseId: exercise.id, sets: [{ reps: 5, weightKg: 60 }] }],
      },
    })) as Entity<any>;
    let workout = (await s.execute('start_workout', {
      operationId: op(),
      planId: plan.id,
      startedAt: '2026-10-20T16:00:00Z',
    })) as Entity<any>;
    workout = (await s.execute('log_workout_set', {
      operationId: op(),
      workoutId: workout.id,
      expectedVersion: workout.version,
      exerciseId: exercise.id,
      set: { reps: 4, weightKg: 60, rpe: 8 },
    })) as Entity<any>;
    workout = (await s.execute('finish_workout', {
      operationId: op(),
      id: workout.id,
      expectedVersion: workout.version,
      finishedAt: '2026-10-20T17:00:00Z',
    })) as Entity<any>;
    await s.execute('save_training_plan', {
      operationId: op(),
      id: plan.id,
      expectedVersion: plan.version,
      data: {
        name: 'Session B',
        exercises: [{ exerciseId: exercise.id, sets: [{ reps: 8, weightKg: 80 }] }],
      },
    });
    workout = (await s.execute('revise_workout_set', {
      operationId: op(),
      workoutId: workout.id,
      setId: workout.data.sets[0].id,
      expectedVersion: workout.version,
      set: { reps: 5, weightKg: 60, rpe: 8 },
    })) as Entity<any>;
    expect(workout.data.plan.snapshot.exercises[0].sets[0].reps).toBe(5);
    expect(workout.data.plan.snapshot.name).toBe('Session A');
    const offlineWorkout = (await s.execute('start_workout', {
      operationId: op(),
      planId: plan.id,
      planVersion: plan.version,
      source: 'watch',
      startedAt: '2026-10-20T18:00:00Z',
    })) as Entity<any>;
    expect(offlineWorkout.data.source).toBe('watch');
    expect(offlineWorkout.data.plan.version).toBe(plan.version);
    expect(offlineWorkout.data.plan.snapshot.exercises[0].sets[0].reps).toBe(5);
    const history = (await s.execute('get_exercise_history', { exerciseId: exercise.id })) as any;
    expect(
      history.items.some((item: any) => item.workoutId === workout.id && item.sets[0].reps === 5),
    ).toBe(true);
  });
});

describe('nutrition and localization', () => {
  it('preserves unknown nutrients and requires explicit unit conversions and estimate basis', () => {
    expect(foodNutrition(rice(), 100, 'g').fiberG).toBeNull();
    expect(() => foodNutrition(rice(), 100, 'ml')).toThrow();
    expect(() => foodNutrition(rice(), 1, 'serving')).toThrow();
    expect(foodSchema.safeParse({ ...rice(), source: { kind: 'bot_estimate' } }).success).toBe(
      false,
    );
    expect(foodNutrition({ ...rice(), densityGPerMl: 0.5 }, 200, 'ml').energyKcal).toBe(130);
    const portion = {
      ...rice(),
      basis: { quantity: 1, unit: 'serving' as const },
      servingSize: { quantity: 100, unit: 'g' as const },
    };
    expect(foodNutrition(portion, 200, 'g').energyKcal).toBe(260);
    expect(foodNutrition({ ...portion, densityGPerMl: 0.5 }, 400, 'ml').energyKcal).toBe(260);
    expect(
      foodNutrition({ ...portion, basis: { quantity: 2, unit: 'serving' } }, 200, 'g').energyKcal,
    ).toBe(130);
    expect(() =>
      foodNutrition({ ...rice(), basis: { quantity: 1, unit: 'serving' } }, 100, 'g'),
    ).toThrow();
  });
  it('uses local calendar bounds across daylight saving transitions', () => {
    const spring = dayBounds('2026-03-08', 'America/New_York');
    const fall = dayBounds('2026-11-01', 'America/New_York');
    expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe(23 * 3600000);
    expect(Date.parse(fall.to) - Date.parse(fall.from)).toBe(25 * 3600000);
    expect(() => dayBounds('2026-02-31', 'America/New_York')).toThrow();
  });
  it('keeps language catalogs aligned and resolves supported ranges with an English fallback', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    expect(resolveLocale(null, 'fr-FR, zh-CN;q=0.9, en;q=0.5')).toBe('zh-CN');
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale(null, 'de-DE')).toBe('en');
    expect(messages['zh-CN'].botInstructions).not.toEqual(messages.en.botInstructions);
  });
  it('keeps computations identical across languages and aggregates meals by owner time zone', async () => {
    const s = service();
    const day = '2030-05-14';
    await s.execute('log_meal', {
      operationId: op(),
      occurredAt: day + 'T12:00:00-04:00',
      ingredients: [{ food: rice(), quantity: 100, unit: 'g' }],
    });
    const [english, chinese] = await Promise.all([
      s.execute('get_daily_nutrition', { day }),
      service('zh-CN').execute('get_daily_nutrition', { day }),
    ]);
    expect(english).toEqual(chinese);
    expect((english as any).nutrients.energyKcal).toBe(130);
  });
});

describe('private recipe media', () => {
  it('imports processed images without retaining signed query strings and reports unavailable sources', async () => {
    const s = service();
    const media = new MediaService(
      s,
      env,
      new R2ObjectStore(env.MEDIA),
      'http://localhost:8787',
      async (_url, init) => {
        expect(init?.redirect).toBe('error');
        return new Response(imageBytes(), { headers: { 'Content-Type': 'image/png' } });
      },
    );
    media.register();
    const imported = (await s.execute('import_recipe_image', {
      operationId: op(),
      sourceUrl: 'https://images.example.com/processed.png?signature=temporary',
    })) as Entity<any>;
    expect(imported.data.source).toBe('https://images.example.com/processed.png');
    expect(
      new Uint8Array(
        await (
          await media.content(imported.id, new Request('http://localhost:8787'))
        ).arrayBuffer(),
      ),
    ).toEqual(imageBytes());
    new MediaService(
      s,
      env,
      new R2ObjectStore(env.MEDIA),
      'http://localhost:8787',
      async () => new Response(null, { status: 410 }),
    ).register();
    await expect(
      s.execute('import_recipe_image', {
        operationId: op(),
        sourceUrl: 'https://images.example.com/expired.png',
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_FETCH_FAILED' });
  });
  it('enforces streaming byte limits, upload expiry, and readiness before binding', async () => {
    const s = service();
    const media = new MediaService(s, env, new R2ObjectStore(env.MEDIA), 'http://localhost:8787');
    media.register();
    const input = { operationId: op(), contentType: 'image/png' };
    const upload = (await s.execute('create_media_upload', input)) as any;
    expect(await s.execute('create_media_upload', input)).toEqual(upload);
    expect(
      (
        await env.DB.prepare('SELECT token_hash FROM upload_tickets WHERE asset_id=?')
          .bind(upload.asset.id)
          .all()
      ).results,
    ).toHaveLength(1);
    const saved = await recipe(s);
    await expect(
      s.execute('attach_recipe_image', {
        operationId: op(),
        recipeId: saved.id,
        expectedVersion: saved.version,
        assetId: upload.asset.id,
      }),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    await env.DB.prepare('UPDATE upload_tickets SET expires_at=0 WHERE asset_id=?')
      .bind(upload.asset.id)
      .run();
    await expect(
      media.upload(
        new Request(upload.uploadUrl, { method: 'PUT', body: imageBytes() }),
        upload.uploadUrl.split('/').at(-1)!,
      ),
    ).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    await expect(boundedBody(new Response(imageBytes()), 32)).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE',
    });
    await expect(
      boundedBody(new Response(imageBytes(), { headers: { 'Content-Length': '1000' } }), 100),
    ).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });
  it('cleans abandoned assets and retains covers referenced by historical meal snapshots', async () => {
    const s = service();
    const media = new MediaService(s, env, new R2ObjectStore(env.MEDIA), 'http://localhost:8787');
    media.register();
    const upload = (await s.execute('create_media_upload', {
      operationId: op(),
      contentType: 'image/png',
    })) as any;
    const asset = (await media.upload(
      new Request(upload.uploadUrl, { method: 'PUT', body: imageBytes() }),
      upload.uploadUrl.split('/').at(-1)!,
    )) as Entity<any>;
    const saved = await recipe(s);
    const covered = (await s.execute('attach_recipe_image', {
      operationId: op(),
      recipeId: saved.id,
      expectedVersion: saved.version,
      assetId: asset.id,
    })) as Entity<any>;
    await s.execute('log_meal_from_recipe', {
      operationId: op(),
      recipeId: saved.id,
      occurredAt: '2026-10-20T16:00:00Z',
    });
    await s.execute('save_recipe', {
      operationId: op(),
      id: saved.id,
      expectedVersion: covered.version,
      data: { ...covered.data, coverAssetId: null },
    });
    const abandoned = (await s.execute('create_media_upload', {
      operationId: op(),
      contentType: 'image/png',
    })) as any;
    const old = new Date(Date.now() - 172800000).toISOString();
    await env.DB.prepare(
      "UPDATE documents SET version=version+1,updated_at=? WHERE kind='asset' AND id IN (?,?)",
    )
      .bind(old, asset.id, abandoned.asset.id)
      .run();
    await cleanupMedia(env);
    expect(await s.repository.get('owner', 'asset', asset.id)).not.toBeNull();
    expect(await env.MEDIA.get(asset.data.objectKey)).not.toBeNull();
    expect(await s.repository.get('owner', 'asset', abandoned.asset.id)).toBeNull();
  });
  it('validates bytes, accepts a single upload, and updates only the recipe cover revision', async () => {
    const s = service();
    const media = new MediaService(s, env, new R2ObjectStore(env.MEDIA), 'http://localhost:8787');
    media.register();
    const upload = (await s.execute('create_media_upload', {
      operationId: op(),
      contentType: 'image/png',
    })) as any;
    const token = upload.uploadUrl.split('/').at(-1)!;
    const request = () =>
      new Request(upload.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: imageBytes(),
      });
    const asset = (await media.upload(request(), token)) as Entity<any>;
    expect(asset.data.width).toBe(1);
    expect(asset.data.status).toBe('ready');
    await expect(media.upload(request(), token)).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    const thumbnailUpload = (await s.execute('create_media_upload', {
      operationId: op(),
      contentType: 'image/png',
      role: 'thumbnail',
    })) as any;
    const thumbnail = (await media.upload(
      new Request(thumbnailUpload.uploadUrl, { method: 'PUT', body: imageBytes() }),
      thumbnailUpload.uploadUrl.split('/').at(-1)!,
    )) as Entity<any>;
    const saved = await recipe(s);
    const covered = (await s.execute('attach_recipe_image', {
      operationId: op(),
      recipeId: saved.id,
      assetId: asset.id,
      thumbnailAssetId: thumbnail.id,
      expectedVersion: saved.version,
    })) as Entity<any>;
    expect(covered.data.nutritionVersion).toBe(saved.data.nutritionVersion);
    expect(covered.data.coverThumbnailAssetId).toBe(thumbnail.id);
    expect(covered.data.nutrients).toEqual(saved.data.nutrients);
    expect(
      (await media.content(asset.id, new Request('http://localhost:8787'))).headers.get(
        'Content-Type',
      ),
    ).toBe('image/png');
  });
  it('rejects invalid file headers and private-network import targets', () => {
    expect(() => inspectImage(new TextEncoder().encode('<svg></svg>').buffer)).toThrow();
    for (const source of [
      'http://example.com/a.png',
      'https://127.0.0.1/a',
      'https://169.254.169.254/a',
      'https://10.0.0.1/a',
      'https://[::1]/a',
      'https://service.local/a',
    ])
      expect(() => publicImageUrl(source)).toThrow();
    expect(publicImageUrl('https://images.example.com/a.png').hostname).toBe('images.example.com');
  });
});
