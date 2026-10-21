import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { D1ExerciseCatalog } from '../src/adapters/d1-exercise-catalog';
import { D1Repository } from '../src/adapters/cloudflare';
import { createApp } from '../src/app';
import { decodeExerciseCursor, loggingCategory } from '../src/domain/exercise-catalog';
import { exerciseSchema, type Exercise } from '../src/domain/schemas';
import { FitnessService } from '../src/domain/service';
import type { Actor, Entity, Locale } from '../src/types';
import fixture from './fixtures/catalog-exercises.json';

const actor = (locale: Locale = 'en', ownerId = 'owner'): Actor => ({
  ownerId,
  id: ownerId,
  kind: 'owner',
  locale,
  timeZone: 'America/New_York',
});
const service = (locale: Locale = 'en', ownerId = 'owner') =>
  new FitnessService(
    new D1Repository(env.DB),
    actor(locale, ownerId),
    {
      lookup: async () => ({ food: null, stale: false }),
      search: async () => ({ items: [], catalogStatus: 'ok' as const }),
      refresh: async () => {
        throw new Error('catalog refresh is not configured');
      },
    },
    new D1ExerciseCatalog(env.DB),
  );
const op = () => crypto.randomUUID();

describe('exercise catalogue', () => {
  it('derives the logging category from the body part', () => {
    expect(loggingCategory('cardio')).toBe('duration');
    expect(loggingCategory('chest')).toBe('strength');
    expect(loggingCategory(null)).toBe('strength');
  });

  it('parses a catalogue exercise and exposes diagram links without artwork geometry', () => {
    const bench = fixture.exercises.find((row) => row.externalId === '0025');
    expect(bench).toBeDefined();
    const parsed = exerciseSchema.parse(bench!.data);
    expect(parsed.mediaAssetIds).toEqual([]);
    expect(parsed.source?.kind).toBe('catalog');
    expect(parsed.source?.origin).toBe('exercisedb');
    expect(parsed.source?.license).toBe('MIT');
    expect(parsed.muscleMap?.primaries).toEqual(['chest']);
    expect(JSON.stringify(parsed)).not.toMatch(/\.gif|gifUrl|https?:\/\//);
  });

  it('returns catalogue rows for an owner with no exercises, in English and Chinese', async () => {
    const english = (await service().execute('search_exercises', {
      query: 'bench',
      limit: 100,
      source: 'catalog',
    })) as { items: Entity<Exercise>[] };
    const bench = english.items.find((item) => item.id === 'cat-0025');
    const later = english.items.find((item) => item.id === 'cat-0026');
    expect(bench?.version).toBe(0);
    expect(bench?.data.name).toBe('barbell bench press');
    expect(bench && later).toBeTruthy();
    expect(english.items.indexOf(bench!)).toBeLessThan(english.items.indexOf(later!));
    const chinese = (await service('zh-CN').execute('search_exercises', {
      query: '卧推',
      limit: 20,
      source: 'catalog',
    })) as { items: Entity<Exercise>[] };
    expect(chinese.items.some((item) => item.id === 'cat-0025')).toBe(true);
    const pullups = (await service('zh-CN').execute('search_exercises', {
      query: '引体向上',
      limit: 20,
      source: 'catalog',
    })) as { items: Entity<Exercise>[] };
    expect(pullups.items.some((item) => item.id === 'cat-0652')).toBe(true);
    await env.DB.prepare(
      `UPDATE catalog_exercise_i18n SET description = ? WHERE exercise_id = 'cat-0025'`,
    )
      .bind('仰卧把杠铃从胸前推起，这个探针句只用于检索。')
      .run();
    const byDescription = (await service('zh-CN').execute('search_exercises', {
      query: '探针句只用于检索',
      limit: 20,
      source: 'catalog',
    })) as { items: Entity<Exercise>[] };
    expect(byDescription.items.map((item) => item.id)).toContain('cat-0025');
    const localized = (await service('zh-CN').execute('get_exercise', {
      id: 'cat-0025',
    })) as Entity<Exercise>;
    expect(localized.data.name).toBe('杠铃卧推');
    expect(localized.data.description).toContain('探针句只用于检索');
    expect(localized.data.aliases).toContain('barbell bench press');
    expect(localized.data.diagram?.hrefs?.[0]?.href).toBe('/musclemap/male-front.svg');
    expect(localized.data.diagram?.gender).toBe('male');
    expect(localized.data.diagram?.views).toEqual(['front']);
    const chest = localized.data.diagram?.highlights?.find((item) => item.region === 'chest');
    expect(chest?.role).toBe('primary');
    expect(chest?.matched).toBe(true);
    expect(chest?.surfaces).toContain('CHEST_LEFT');
    const deltoid = localized.data.diagram?.highlights?.find((item) => item.region === 'deltoids');
    expect(deltoid?.role).toBe('secondary');
    expect(deltoid?.groups).toContain('SHOULDERS_FRONT');
  });

  it('filters catalogue rows and ranks a name prefix ahead of a looser match', async () => {
    const now = '2026-10-21T00:00:00.000Z';
    await env.DB.prepare(
      `INSERT OR REPLACE INTO catalog_exercises(
        id, external_id, source, catalog_version, data, search_text,
        body_part, equipment, target, movement_category, needs_rewrite, updated_at
      ) VALUES (?, ?, 'opengym', 1, ?, 'bench press chest', 'chest', 'barbell', 'pectorals', 'strength', 1, ?)`,
    )
      .bind(
        'cat-90001',
        '90001',
        JSON.stringify({
          name: 'bench press',
          aliases: [],
          category: 'strength',
          instructions: '',
          description: null,
          needsRewrite: true,
          muscleGroups: ['pectorals'],
          equipment: ['barbell'],
          mediaAssetIds: [],
          notes: '',
          bodyPart: 'chest',
          primaryMuscles: ['pectorals'],
          secondaryMuscles: [],
          movementCategory: 'strength',
          source: { kind: 'catalog', origin: 'opengym', catalogId: 'cat-90001', catalogVersion: 1 },
          diagram: { gender: 'male', views: ['front'], regions: ['chest'] },
        }),
        now,
      )
      .run();
    const ranked = (await service().execute('search_exercises', {
      query: 'bench',
      limit: 100,
      source: 'catalog',
    })) as { items: Entity<Exercise>[] };
    const prefix = ranked.items.findIndex((item) => item.id === 'cat-90001');
    const contains = ranked.items.findIndex((item) => item.id === 'cat-0025');
    expect(prefix).toBeGreaterThanOrEqual(0);
    expect(contains).toBeGreaterThan(prefix);
    const chest = (await service().execute('search_exercises', {
      bodyPart: 'chest',
      equipment: 'barbell',
      target: 'pectorals',
      movementCategory: 'strength',
      limit: 100,
      source: 'catalog',
    })) as { items: Entity<Exercise>[] };
    expect(chest.items.some((item) => item.id === 'cat-0025')).toBe(true);
    expect(chest.items.some((item) => item.id === 'cat-0043')).toBe(false);
  });

  it('pages from owner exercises into the catalogue without duplicating an adopted id', async () => {
    const saved = (await service().execute('save_exercise', {
      operationId: op(),
      data: { name: 'Alpha lift', equipment: ['barbell'] },
    })) as Entity<Exercise>;
    const first = (await service().execute('search_exercises', { limit: 1, source: 'all' })) as {
      items: Entity<Exercise>[];
      cursor: string | null;
    };
    expect(first.items.map((item) => item.id)).toEqual([saved.id]);
    const cursor = decodeExerciseCursor(first.cursor!);
    expect(cursor.phase === 'mine' || cursor.phase === 'catalog').toBe(true);
    const mine = (await service().execute('search_exercises', {
      query: 'musclegroups',
      source: 'mine',
    })) as { items: Entity<Exercise>[] };
    expect(mine.items).toEqual([]);
    const named = (await service().execute('search_exercises', {
      query: 'alpha',
      source: 'mine',
    })) as { items: Entity<Exercise>[] };
    expect(named.items.map((item) => item.id)).toEqual([saved.id]);
    let page = first;
    const seen = new Set(page.items.map((item) => item.id));
    let foundCatalog = page.items.some((item) => item.version === 0);
    for (let step = 0; step < 6 && page.cursor && !foundCatalog; step += 1) {
      page = (await service().execute('search_exercises', {
        limit: 10,
        cursor: page.cursor,
        source: 'all',
      })) as typeof page;
      for (const item of page.items) seen.add(item.id);
      foundCatalog = page.items.some((item) => item.version === 0);
    }
    expect(foundCatalog).toBe(true);
    expect(seen.has(saved.id)).toBe(true);
  });

  it('adopts once, rejects forged catalogue writes, and keeps a pending description empty', async () => {
    const firstId = op();
    const first = (await service().execute('adopt_exercise', {
      operationId: firstId,
      id: 'cat-10003',
    })) as { exercise: Entity<Exercise>; created: boolean };
    const second = (await service().execute('adopt_exercise', {
      operationId: op(),
      id: '10003',
    })) as { exercise: Entity<Exercise>; created: boolean };
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.exercise.id).toBe(first.exercise.id);
    expect(second.exercise.version).toBe(1);
    const replay = (await service().execute('adopt_exercise', {
      operationId: firstId,
      id: 'cat-10003',
    })) as { created: boolean };
    expect(replay).toEqual(first);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE owner_id='owner' AND kind='exercise' AND id='cat-10003'",
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
    await expect(
      service().execute('save_exercise', {
        operationId: op(),
        id: 'cat-90001',
        data: { name: 'Nope' },
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_ID_RESERVED' });
    await expect(
      service().execute('save_exercise', {
        operationId: op(),
        data: { name: 'Nope', source: { kind: 'catalog', origin: 'exercisedb' } },
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_SOURCE_RESERVED' });
    const pending = (await service().execute('get_exercise', {
      id: 'cat-0136',
    })) as Entity<Exercise>;
    expect(pending.data.needsRewrite).toBe(true);
    expect(pending.data.description).toBeNull();
    expect(pending.data.instructions).toBe('');
    const squat = (await service().execute('get_exercise', { id: 'cat-1197' })) as Entity<Exercise>;
    expect(squat.data.needsRewrite).toBe(false);
    expect(squat.data.description).toContain('hips');
  });

  it('adopts inside the same commit as a plan or freestyle set and rolls back together', async () => {
    await expect(
      service().execute('save_training_plan', {
        operationId: op(),
        data: {
          name: 'Broken',
          exercises: [
            { exerciseId: 'cat-0007', sets: [{ reps: 5 }] },
            { exerciseId: 'missing-exercise', sets: [{ reps: 5 }] },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await env.DB.prepare("SELECT id FROM documents WHERE id='cat-0007'").first()).toBeNull();

    const plan = (await service('zh-CN').execute('save_training_plan', {
      operationId: op(),
      data: {
        name: 'Pull',
        exercises: [{ exerciseId: 'cat-0652', sets: [{ reps: 5 }] }],
      },
    })) as Entity<{ exercises: { exerciseSnapshot: Exercise }[] }> & {
      adoptedExercises?: Entity<Exercise>[];
    };
    expect(plan.adoptedExercises).toHaveLength(1);
    expect(plan.data.exercises[0]?.exerciseSnapshot.name).toBe('引体向上');
    const operation = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE owner_id='owner' AND id IN ('cat-0652') AND kind='exercise'",
    ).first<{ count: number }>();
    expect(operation?.count).toBe(1);

    const anchor = (await service().execute('save_exercise', {
      operationId: op(),
      data: { name: 'Anchor' },
    })) as Entity<Exercise>;
    const existing = (await service().execute('save_training_plan', {
      operationId: op(),
      data: { name: 'Anchor plan', exercises: [{ exerciseId: anchor.id, sets: [{ reps: 3 }] }] },
    })) as Entity<{ name: string }>;
    const rollbackId = 'cat-0015';
    await expect(
      service().repository.commit({
        actor: actor(),
        operation: 'save_training_plan',
        operationId: op(),
        requestHash: 'exercise-rollback',
        response: { ok: false },
        mutations: [
          {
            entity: {
              id: rollbackId,
              kind: 'exercise',
              version: 1,
              data: { name: 'Should roll back', mediaAssetIds: [] },
              createdAt: '2026-10-21T00:00:00.000Z',
              updatedAt: '2026-10-21T00:00:00.000Z',
            },
          },
          {
            entity: { ...existing, version: existing.version + 1 },
            expectedVersion: existing.version + 4,
          },
        ],
      }),
    ).rejects.toBeDefined();
    expect(await service().repository.get('owner', 'exercise', rollbackId)).toBeNull();

    const workout = (await service().execute('start_workout', {
      operationId: op(),
      name: 'Freestyle',
    })) as Entity<{ sets: { exerciseSnapshot: Exercise }[] }>;
    const logged = (await service().execute('log_workout_set', {
      operationId: op(),
      workoutId: workout.id,
      expectedVersion: workout.version,
      exerciseId: 'cat-0501',
      set: { durationSeconds: 30 },
    })) as Entity<{ sets: { exerciseSnapshot: Exercise }[] }> & {
      adoptedExercises?: Entity<Exercise>[];
    };
    expect(logged.adoptedExercises?.[0]?.id).toBe('cat-0501');
    expect(logged.data.sets[0]?.exerciseSnapshot.category).toBe('duration');
  });

  it('does not rewrite adopted rows or snapshots when the catalogue changes', async () => {
    const adopted = (await service().execute('adopt_exercise', {
      operationId: op(),
      id: 'cat-0662',
    })) as { exercise: Entity<Exercise> };
    const plan = (await service().execute('save_training_plan', {
      operationId: op(),
      data: {
        name: 'Push',
        exercises: [{ exerciseId: 'cat-0662', sets: [{ reps: 8 }] }],
      },
    })) as Entity<{ exercises: { exerciseSnapshot: Exercise }[] }>;
    const beforePlan = await env.DB.prepare('SELECT data FROM documents WHERE id=?')
      .bind(plan.id)
      .first<{ data: string }>();
    const beforeRevision = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM document_revisions WHERE id=?',
    )
      .bind(adopted.exercise.id)
      .first<{ count: number }>();
    const replacement = JSON.stringify({
      ...adopted.exercise.data,
      name: 'Changed in catalogue only',
    });
    await env.DB.prepare(
      'UPDATE catalog_exercises SET catalog_version=2, data=?, updated_at=? WHERE id=?',
    )
      .bind(replacement, '2026-10-22T00:00:00.000Z', 'cat-0662')
      .run();
    const afterPlan = await env.DB.prepare('SELECT data FROM documents WHERE id=?')
      .bind(plan.id)
      .first<{ data: string }>();
    const afterExercise = await env.DB.prepare('SELECT data, version FROM documents WHERE id=?')
      .bind('cat-0662')
      .first<{ data: string; version: number }>();
    const afterRevision = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM document_revisions WHERE id=?',
    )
      .bind('cat-0662')
      .first<{ count: number }>();
    expect(afterPlan?.data).toBe(beforePlan?.data);
    expect(afterExercise?.data).toContain('俯卧撑');
    expect(afterExercise?.version).toBe(1);
    expect(afterRevision?.count).toBe(beforeRevision?.count);
    expect(plan.data.exercises[0]?.exerciseSnapshot.name).toBe('push-up');
  });

  it('shows a catalogue row again after delete and restores it without a conflict', async () => {
    const adopted = (await service().execute('adopt_exercise', {
      operationId: op(),
      id: 'cat-3094',
    })) as { exercise: Entity<Exercise> };
    await service().execute('delete_exercise', {
      operationId: op(),
      id: adopted.exercise.id,
      expectedVersion: adopted.exercise.version,
    });
    const virtual = (await service().execute('get_exercise', {
      id: 'cat-3094',
    })) as Entity<Exercise>;
    expect(virtual.version).toBe(0);
    const search = (await service().execute('search_exercises', {
      query: 'jumping jack',
      source: 'catalog',
      limit: 20,
    })) as { items: Entity<Exercise>[] };
    expect(search.items.some((item) => item.id === 'cat-3094')).toBe(true);
    const again = (await service().execute('adopt_exercise', {
      operationId: op(),
      id: 'cat-3094',
    })) as { exercise: Entity<Exercise>; created: boolean };
    expect(again.created).toBe(true);
    expect(again.exercise.version).toBe(adopted.exercise.version + 2);
    expect(again.exercise.deleted).toBeUndefined();
  });

  it('keeps catalogue rows global and adopted copies inside one owner', async () => {
    const other = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO owners(id,status,created_at) VALUES(?,?,?)')
      .bind(other, 'active', Date.now())
      .run();
    await service().execute('adopt_exercise', { operationId: op(), id: 'cat-0026' });
    const outsider = (await service('en', other).execute('get_exercise', {
      id: 'cat-0026',
    })) as Entity<Exercise>;
    expect(outsider.version).toBe(0);
    const hidden = (await service('en', other).execute('search_exercises', {
      source: 'mine',
      limit: 100,
    })) as { items: Entity<Exercise>[] };
    expect(hidden.items.some((item) => item.id === 'cat-0026')).toBe(false);
    const visible = (await service('en', other).execute('search_exercises', {
      query: 'barbell bench squat',
      source: 'catalog',
      limit: 20,
    })) as { items: Entity<Exercise>[] };
    expect(visible.items.some((item) => item.id === 'cat-0026')).toBe(true);
    const female = (await service('en', other).execute('get_exercise', {
      id: 'cat-0004',
    })) as Entity<Exercise>;
    expect(female.data.diagram?.gender).toBe('female');
    expect(female.data.variantOf).toBe('cat-5266');
    expect(female.data.diagram?.hrefs?.map((item) => item.href).join(' ')).toContain('female');
  });

  it('publishes taxonomy, attribution, and the generated body diagrams', async () => {
    const taxonomy = (await service('zh-CN').execute('list_exercise_taxonomy', {})) as {
      bodyParts: { id: string; label: string }[];
      diagrams: {
        artwork: string;
        regions: string[];
        unmatched: string[];
        assets: { male: { front: string } };
        mapping: { region: string; matched: boolean; surfaces: string[] }[];
      };
      attribution: string;
    };
    expect(taxonomy.bodyParts.find((item) => item.id === 'chest')?.label).toBe('胸部');
    expect(taxonomy.diagrams.artwork).toBe('ready');
    expect(taxonomy.diagrams.regions).toContain('upper-back');
    expect(taxonomy.diagrams.unmatched).toEqual([]);
    const upper = taxonomy.diagrams.mapping.find((item) => item.region === 'upper-back');
    expect(upper?.surfaces).toEqual(['UPPER_BACK_LEFT', 'UPPER_BACK_RIGHT']);
    expect(upper?.surfaces).not.toContain('LATISSIMUS_LEFT');
    expect(taxonomy.diagrams.mapping.find((item) => item.region === 'hip-flexors')?.matched).toBe(
      true,
    );
    expect(taxonomy.diagrams.mapping.find((item) => item.region === 'serratus')?.matched).toBe(
      true,
    );
    expect(taxonomy.diagrams.assets.male.front).toBe('/musclemap/male-front.svg');
    expect(taxonomy.attribution).toContain('openGym');
    const missingCtx = createExecutionContext();
    const missing = await createApp(env).fetch(
      new Request('http://localhost:8787/musclemap/male-front.svg'),
      env,
      missingCtx,
    );
    await waitOnExecutionContext(missingCtx);
    const blockedCtx = createExecutionContext();
    const blocked = await createApp(env).fetch(
      new Request('http://localhost:8787/musclemap/secret.svg'),
      env,
      blockedCtx,
    );
    await waitOnExecutionContext(blockedCtx);
    expect(missing.status).toBe(200);
    expect(blocked.status).toBe(404);
    const svg = await missing.text();
    expect(svg).toContain('viewBox="0 0 1024 1536"');
    expect(svg).toContain('data-surface="CHEST_LEFT"');
    expect(svg).toContain('data-region="chest"');
    expect(svg).toContain('data-surface="HIP_FLEXOR_LEFT"');
    expect(svg).toContain('data-surface="SERRATUS_LEFT"');
    expect(svg).toContain('data-extra="open-fitness"');
    expect(svg).not.toMatch(/webp|body-paths/i);
    const back = await createApp(env).fetch(
      new Request('http://localhost:8787/musclemap/male-back.svg'),
      env,
      createExecutionContext(),
    );
    expect(await back.text()).toContain('data-surface="UPPER_BACK_LEFT"');
  });
});
