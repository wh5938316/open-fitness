import { z } from 'zod';
import { canonical, sha256 } from '../crypto';
import { AppError, assert, conflict, notFound } from '../errors';
import { t } from '../i18n';
import type {
  Actor,
  Commit,
  Entity,
  EntityKind,
  MediaReference,
  Mutation,
  Repository,
} from '../types';
import {
  dayBounds,
  foodNutrition,
  portionIngredients,
  scaleNutrients,
  sumNutrients,
} from './nutrition';
import {
  deleteSchema,
  exerciseSchema,
  foodSchema,
  getSchema,
  id,
  ingredientSchema,
  ingredientsSchema,
  isoDateTime,
  listSchema,
  mutation,
  notes,
  operationId,
  overrideSchema,
  planSchema,
  positive,
  recipeSchema,
  setSchema,
  type Exercise,
  type Food,
  type Ingredient,
  type IngredientInput,
  type Meal,
  type Plan,
  type Recipe,
  type Workout,
} from './schemas';

export interface FoodCatalog {
  lookup(barcode: string): Promise<Food | null>;
  search(query: string): Promise<Food[]>;
}
export interface Prepared {
  response: unknown;
  mutations: Mutation[];
  exports?: Commit['exports'];
  mediaReferences?: MediaReference[];
  ownerUpdate?: Commit['ownerUpdate'];
  uploadTicket?: Commit['uploadTicket'];
}
export interface Operation {
  name: string;
  description: string;
  schema: z.ZodType;
  readOnly: boolean;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  run: (args: any) => Promise<unknown | Prepared>;
}
export function isPrepared(value: unknown): value is Prepared {
  return Boolean(value && typeof value === 'object' && 'mutations' in value && 'response' in value);
}

export class FitnessService {
  operations = new Map<string, Operation>();
  constructor(
    public repository: Repository,
    public actor: Actor,
    private catalog: FoodCatalog,
  ) {
    this.registerOperations();
  }
  add(operation: Operation): void {
    this.operations.set(operation.name, operation);
  }
  async execute(name: string, raw: unknown): Promise<unknown> {
    const operation = this.operations.get(name);
    if (!operation) throw notFound();
    const parsed = operation.schema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(
        422,
        'INVALID_INPUT',
        'invalidInput',
        parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      );
    const args = parsed.data as Record<string, unknown>;
    const requestHash = await sha256(canonical({ name, args, actor: this.actor.id }));
    if (!operation.readOnly) {
      const replay = await this.repository.replay(
        this.actor.ownerId,
        String(args.operationId),
        requestHash,
      );
      if (replay) return replay.response;
    }
    const result = await operation.run(args);
    if (!isPrepared(result)) return result;
    return this.repository.commit({
      actor: this.actor,
      operation: name,
      operationId: String(args.operationId),
      requestHash,
      ...result,
    });
  }
  async require<T>(kind: EntityKind, entityId: string): Promise<Entity<T>> {
    const doc = await this.repository.get<T>(this.actor.ownerId, kind, entityId);
    if (!doc) throw notFound();
    return doc;
  }
  async save<T>(
    kind: EntityKind,
    data: T,
    input: { id?: string; expectedVersion?: number },
  ): Promise<Entity<T>> {
    if (input.id) {
      assert(input.expectedVersion !== undefined, 'EXPECTED_VERSION_REQUIRED');
      const old = await this.require<T>(kind, input.id);
      if (old.version !== input.expectedVersion) throw conflict();
      return { ...old, version: old.version + 1, data, updatedAt: new Date().toISOString() };
    }
    assert(input.expectedVersion === undefined, 'UNEXPECTED_VERSION');
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), kind, version: 1, data, createdAt: now, updatedAt: now };
  }
  prepared(doc: Entity<any>, expectedVersion?: number, extra: Partial<Prepared> = {}): Prepared {
    const assetIds = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (
          ['coverAssetId', 'coverThumbnailAssetId', 'imageAssetId'].includes(key) &&
          typeof item === 'string'
        )
          assetIds.add(item);
        else if (key === 'mediaAssetIds' && Array.isArray(item))
          item.forEach((id) => {
            if (typeof id === 'string') assetIds.add(id);
          });
        else visit(item);
      }
    };
    if (!doc.deleted && doc.kind !== 'asset') visit(doc.data);
    return {
      response: doc,
      mutations: [{ entity: doc, expectedVersion }],
      ...extra,
      mediaReferences: [...assetIds].map((assetId, index) => ({
        assetId,
        targetKind: doc.kind,
        targetId: doc.id,
        slot: `asset-${index}`,
      })),
    };
  }
  async ingredients(inputs: IngredientInput[]): Promise<Ingredient[]> {
    const result = await Promise.all(
      inputs.map(async (input) => {
        const food = input.foodId
          ? (await this.require<Food>('food', input.foodId)).data
          : input.food!;
        return {
          id: input.id ?? crypto.randomUUID(),
          foodId: input.foodId,
          label: input.label ?? food.name,
          quantity: input.quantity,
          unit: input.unit,
          food: structuredClone(food),
          nutrients: foodNutrition(food, input.quantity, input.unit),
        };
      }),
    );
    assert(new Set(result.map((item) => item.id)).size === result.length, 'DUPLICATE_INGREDIENT');
    return result;
  }
  async readyAsset(assetId: string | null | undefined): Promise<void> {
    if (!assetId) return;
    const asset = await this.require<{ status: string }>('asset', assetId);
    assert(asset.data.status === 'ready', 'ASSET_NOT_READY');
  }
  async addIngredients(base: Ingredient[], additions: IngredientInput[]): Promise<Ingredient[]> {
    const result = [...base, ...(await this.ingredients(additions))];
    assert(result.length <= 100, 'TOO_MANY_INGREDIENTS');
    assert(new Set(result.map((item) => item.id)).size === result.length, 'DUPLICATE_INGREDIENT');
    return result;
  }
  mealPrepared(doc: Entity<Meal>, expectedVersion?: number): Prepared {
    return this.prepared(doc, expectedVersion, {
      response: {
        ...doc,
        healthSync: 'awaiting_device',
        healthSyncMessage: t(this.actor.locale, 'awaitingDevice'),
      },
      exports: [
        {
          mealId: doc.id,
          version: doc.version,
          action: doc.deleted ? 'delete' : 'upsert',
          payload: {
            syncIdentifier: `openfitness.meal.${doc.id}`,
            syncVersion: doc.version,
            occurredAt: doc.data.occurredAt,
            nutrients: doc.data.nutrients,
          },
        },
      ],
      mediaReferences: [
        {
          assetId: doc.deleted ? null : (doc.data.imageAssetId ?? null),
          targetKind: 'meal',
          targetId: doc.id,
          slot: 'photo',
        },
      ],
    });
  }
  private registerOperations(): void {
    this.add({
      name: 'get_agent_context',
      description:
        'Read your verified identity, owner preferences, capabilities, and personal coaching instructions.',
      schema: z.object({}),
      readOnly: true,
      method: 'GET',
      path: '/agent-context',
      run: async () => ({
        project: 'OpenFitness',
        actorId: this.actor.id,
        actorType: this.actor.kind,
        ownerId: this.actor.ownerId,
        role: 'fitness_coach',
        permissions: ['full_business_access'],
        locale: this.actor.locale,
        timeZone: this.actor.timeZone,
        instructionsVersion: '1',
        instructions: t(this.actor.locale, 'botInstructions'),
        capabilities: {
          training: true,
          recipes: true,
          meals: true,
          media: true,
          healthExport: 'awaiting_device',
          healthImport: false,
          imageProcessing: 'provided_by_agent',
        },
      }),
    });
    this.add({
      name: 'set_preferences',
      description:
        'Set the owner display language and IANA time zone. API names and stored user text do not change.',
      schema: z.object({
        operationId,
        locale: z.enum(['en', 'zh-CN']).optional(),
        timeZone: z.string().min(1).max(100).optional(),
      }),
      readOnly: false,
      method: 'PUT',
      path: '/preferences',
      run: async (args) => {
        assert(args.locale || args.timeZone, 'PREFERENCE_REQUIRED');
        if (args.timeZone) {
          try {
            new Intl.DateTimeFormat('en', { timeZone: args.timeZone }).format();
          } catch {
            throw new AppError(422, 'INVALID_TIME_ZONE');
          }
        }
        return {
          response: {
            locale: args.locale ?? this.actor.locale,
            timeZone: args.timeZone ?? this.actor.timeZone,
          },
          mutations: [],
          ownerUpdate: { locale: args.locale, timeZone: args.timeZone },
        };
      },
    });
    this.add({
      name: 'list_health_exports',
      description:
        'Inspect pending Apple Health export events. No device bridge is implemented yet; these events remain awaiting_device.',
      schema: z.object({
        limit: z.number().int().min(1).max(100).default(30),
        cursor: z.string().optional(),
      }),
      readOnly: true,
      method: 'GET',
      path: '/health/exports',
      run: async (args) => ({
        ...((await this.repository.healthExports(
          this.actor.ownerId,
          args.limit,
          args.cursor,
        )) as object),
        statusMessage: t(this.actor.locale, 'awaitingDevice'),
      }),
    });

    for (const [kind, plural] of [
      ['exercise', 'exercises'],
      ['plan', 'training-plans'],
      ['workout', 'workouts'],
      ['food', 'foods'],
      ['recipe', 'recipes'],
      ['meal', 'meals'],
      ['asset', 'media'],
    ] as const) {
      const suffix = kind === 'plan' ? 'training_plan' : kind;
      this.add({
        name: `get_${suffix}`,
        description: `Read one ${kind} and its current version.`,
        schema: getSchema,
        readOnly: true,
        method: 'GET',
        path: `/${plural}/:id`,
        run: async (args) => this.require(kind, args.id),
      });
      this.add({
        name:
          kind === 'recipe' || kind === 'food' || kind === 'exercise'
            ? `search_${suffix === 'exercise' ? 'exercises' : suffix + 's'}`
            : `list_${suffix}s`,
        description: `List or search your ${plural} using cursor pagination.`,
        schema: listSchema,
        readOnly: true,
        method: 'GET',
        path: `/${plural}`,
        run: async (args) => this.repository.list(this.actor.ownerId, kind, args),
      });
      if (kind !== 'asset')
        this.add({
          name: `delete_${suffix}`,
          description: `Delete a ${kind} using its current version.`,
          schema: deleteSchema,
          readOnly: false,
          method: 'DELETE',
          path: `/${plural}/:id`,
          run: async (args) => {
            const current = await this.require<any>(kind, args.id);
            if (current.version !== args.expectedVersion) throw conflict();
            const doc = {
              ...current,
              deleted: true,
              version: current.version + 1,
              updatedAt: new Date().toISOString(),
            };
            if (kind === 'meal') return this.mealPrepared(doc, args.expectedVersion);
            return this.prepared(
              doc,
              args.expectedVersion,
              kind === 'recipe'
                ? {
                    mediaReferences: [
                      { assetId: null, targetKind: 'recipe', targetId: doc.id, slot: 'cover' },
                    ],
                  }
                : {},
            );
          },
        });
    }
    for (const [kind, schema, path] of [
      ['exercise', exerciseSchema, '/exercises'],
      ['food', foodSchema, '/foods'],
    ] as const) {
      this.add({
        name: `save_${kind}`,
        description: `Create or update a ${kind}. Supply expectedVersion when updating. Nutrition estimates must include their basis.`,
        schema: z.object({ ...mutation, data: schema }),
        readOnly: false,
        method: 'POST',
        path,
        run: async (args) => {
          if (kind === 'exercise')
            for (const assetId of args.data.mediaAssetIds) await this.readyAsset(assetId);
          const doc = await this.save(kind, args.data, args);
          return this.prepared(doc, args.expectedVersion);
        },
      });
    }
    this.add({
      name: 'lookup_food',
      description:
        'Look up a packaged product in Open Food Facts by barcode. Read-only; save the returned food explicitly to keep it.',
      schema: z.object({ barcode: z.string().regex(/^\d{4,32}$/) }),
      readOnly: true,
      method: 'GET',
      path: '/food-catalog/:barcode',
      run: async (args) => ({ food: await this.catalog.lookup(args.barcode) }),
    });
    this.add({
      name: 'search_food_catalog',
      description:
        'Search Open Food Facts products. Results may be incomplete; explicit estimates are supported for missing ingredients.',
      schema: z.object({ query: z.string().min(2).max(200) }),
      readOnly: true,
      method: 'GET',
      path: '/food-catalog',
      run: async (args) => ({ items: await this.catalog.search(args.query) }),
    });
    this.add({
      name: 'calculate_nutrition',
      description:
        'Calculate nutrition from food IDs or explicit food snapshots and quantities. Unknown nutrients remain null.',
      schema: z.object({ ingredients: ingredientsSchema }),
      readOnly: true,
      method: 'POST',
      path: '/nutrition/calculate',
      run: async (args) => {
        const ingredients = await this.ingredients(args.ingredients);
        return { ingredients, nutrients: sumNutrients(ingredients.map((item) => item.nutrients)) };
      },
    });
    this.add({
      name: 'save_training_plan',
      description:
        'Create or revise a training plan, including exercise snapshots, target sets, rest periods, and superset groups.',
      schema: z.object({ ...mutation, data: planSchema }),
      readOnly: false,
      method: 'POST',
      path: '/training-plans',
      run: async (args) => {
        const exercises = await Promise.all(
          args.data.exercises.map(async (entry: any) => ({
            ...entry,
            exerciseSnapshot: (await this.require<Exercise>('exercise', entry.exerciseId)).data,
          })),
        );
        const doc = await this.save<Plan>('plan', { ...args.data, exercises }, args);
        return this.prepared(doc, args.expectedVersion);
      },
    });
    this.add({
      name: 'save_recipe',
      description:
        'Create a reusable recipe or restaurant meal template. Quantities describe the entire batch; yield.servings defines standard portions. Updating affects future meals only.',
      schema: z.object({ ...mutation, data: recipeSchema }),
      readOnly: false,
      method: 'POST',
      path: '/recipes',
      run: async (args) => {
        await this.readyAsset(args.data.coverAssetId);
        await this.readyAsset(args.data.coverThumbnailAssetId);
        const ingredients = await this.ingredients(args.data.ingredients);
        const nutrients = sumNutrients(ingredients.map((item) => item.nutrients));
        const previous = args.id ? await this.require<Recipe>('recipe', args.id) : null;
        const data: Recipe = {
          ...args.data,
          nutritionVersion: (previous?.data.nutritionVersion ?? 0) + 1,
          ingredients,
          nutrients,
          perServing: scaleNutrients(nutrients, 1 / args.data.yield.servings),
          per100g: args.data.yield.cookedWeightGrams
            ? scaleNutrients(nutrients, 100 / args.data.yield.cookedWeightGrams)
            : null,
        };
        const doc = await this.save<Recipe>('recipe', data, args);
        return this.prepared(doc, args.expectedVersion, {
          mediaReferences: [
            {
              assetId: data.coverAssetId ?? null,
              targetKind: 'recipe',
              targetId: doc.id,
              slot: 'cover',
            },
          ],
        });
      },
    });
    this.add({
      name: 'log_meal',
      description:
        'Record an actual meal from ingredient quantities and save an immutable nutrition snapshot.',
      schema: z.object({
        operationId,
        occurredAt: isoDateTime,
        ingredients: ingredientsSchema,
        notes,
        imageAssetId: id.nullable().optional(),
      }),
      readOnly: false,
      method: 'POST',
      path: '/meals',
      run: async (args) => {
        await this.readyAsset(args.imageAssetId);
        const ingredients = await this.ingredients(args.ingredients);
        const doc = await this.save<Meal>(
          'meal',
          {
            occurredAt: new Date(args.occurredAt).toISOString(),
            ingredients,
            nutrients: sumNutrients(ingredients.map((item) => item.nutrients)),
            notes: args.notes,
            imageAssetId: args.imageAssetId,
          },
          {},
        );
        return this.mealPrepared(doc);
      },
    });
    this.add({
      name: 'log_meal_from_recipe',
      description:
        'Log a saved recipe by servings or cooked grams without reanalyzing it. Overrides replace absolute ingredient amounts after scaling; additions apply only to this meal.',
      schema: z.object({
        operationId,
        recipeId: id,
        servings: positive.optional(),
        grams: positive.optional(),
        overrides: z.array(overrideSchema).default([]),
        additions: z.array(ingredientSchema).max(100).default([]),
        occurredAt: isoDateTime,
        notes,
        imageAssetId: id.nullable().optional(),
      }),
      readOnly: false,
      method: 'POST',
      path: '/meals/from-recipe',
      run: async (args) => {
        const recipe = await this.require<Recipe>('recipe', args.recipeId);
        await this.readyAsset(args.imageAssetId);
        assert(!(args.grams !== undefined && args.servings !== undefined), 'AMBIGUOUS_PORTION');
        if (args.grams !== undefined && !recipe.data.yield.cookedWeightGrams)
          throw new AppError(422, 'MISSING_CONVERSION', 'missingData', {
            required: 'yield.cookedWeightGrams',
          });
        const servings =
          args.grams === undefined
            ? (args.servings ?? recipe.data.defaultServings)
            : (args.grams * recipe.data.yield.servings) / recipe.data.yield.cookedWeightGrams!;
        const portion = portionIngredients(
          recipe.data.ingredients,
          servings / recipe.data.yield.servings,
          args.overrides,
        );
        const ingredients = await this.addIngredients(portion, args.additions);
        const doc = await this.save<Meal>(
          'meal',
          {
            occurredAt: new Date(args.occurredAt).toISOString(),
            notes: args.notes,
            ingredients,
            nutrients: sumNutrients(ingredients.map((item) => item.nutrients)),
            recipe: { id: recipe.id, version: recipe.version, servings, snapshot: recipe.data },
            imageAssetId: args.imageAssetId,
          },
          {},
        );
        return this.mealPrepared(doc);
      },
    });
    this.add({
      name: 'revise_meal',
      description:
        'Correct one recorded meal. This does not modify its source recipe or other meals.',
      schema: z.object({
        operationId,
        id,
        expectedVersion: z.number().int().positive(),
        occurredAt: isoDateTime.optional(),
        ingredients: ingredientsSchema.optional(),
        overrides: z.array(overrideSchema).optional(),
        additions: z.array(ingredientSchema).max(100).default([]),
        notes: z.string().max(10000).optional(),
        imageAssetId: id.nullable().optional(),
      }),
      readOnly: false,
      method: 'PUT',
      path: '/meals/:id',
      run: async (args) => {
        assert(
          !(args.ingredients && (args.overrides || args.additions.length)),
          'AMBIGUOUS_MEAL_REVISION',
        );
        const old = await this.require<Meal>('meal', args.id);
        await this.readyAsset(args.imageAssetId);
        const base = args.ingredients
          ? await this.ingredients(args.ingredients)
          : portionIngredients(old.data.ingredients, 1, args.overrides ?? []);
        const ingredients = await this.addIngredients(base, args.additions);
        const data: Meal = {
          ...old.data,
          ingredients,
          nutrients: sumNutrients(ingredients.map((item) => item.nutrients)),
          notes: args.notes ?? old.data.notes,
          occurredAt: args.occurredAt
            ? new Date(args.occurredAt).toISOString()
            : old.data.occurredAt,
          imageAssetId: args.imageAssetId === undefined ? old.data.imageAssetId : args.imageAssetId,
        };
        return this.mealPrepared(await this.save<Meal>('meal', data, args), args.expectedVersion);
      },
    });
    this.add({
      name: 'get_daily_nutrition',
      description:
        'Aggregate actual meals for a local calendar day, respecting the owner time zone and daylight saving time.',
      schema: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
      readOnly: true,
      method: 'GET',
      path: '/nutrition/daily/:day',
      run: async (args) => {
        const bounds = dayBounds(args.day, this.actor.timeZone);
        let cursor: string | undefined;
        const meals: Entity<Meal>[] = [];
        do {
          const page = await this.repository.list<Meal>(this.actor.ownerId, 'meal', {
            ...bounds,
            limit: 100,
            cursor,
          });
          meals.push(...page.items);
          cursor = page.cursor ?? undefined;
        } while (cursor);
        return {
          day: args.day,
          timeZone: this.actor.timeZone,
          mealCount: meals.length,
          nutrients: sumNutrients(meals.map((item) => item.data.nutrients)),
        };
      },
    });
    this.add({
      name: 'start_workout',
      description:
        'Start a workout with an immutable copy of the current training plan, or start a freestyle workout.',
      schema: z.object({
        operationId,
        planId: id.optional(),
        name: z.string().max(200).optional(),
        startedAt: isoDateTime.optional(),
        notes,
      }),
      readOnly: false,
      method: 'POST',
      path: '/workouts',
      run: async (args) => {
        const plan = args.planId ? await this.require<Plan>('plan', args.planId) : null;
        const data: Workout = {
          name: args.name ?? plan?.data.name ?? 'Freestyle workout',
          state: 'active',
          startedAt: args.startedAt
            ? new Date(args.startedAt).toISOString()
            : new Date().toISOString(),
          sets: [],
          notes: args.notes,
          ...(plan ? { plan: { id: plan.id, version: plan.version, snapshot: plan.data } } : {}),
        };
        return this.prepared(await this.save<Workout>('workout', data, {}));
      },
    });
    this.add({
      name: 'log_workout_set',
      description:
        'Append an actual set, including exercise snapshot, reps, load, duration, distance, and optional effort.',
      schema: z.object({
        operationId,
        workoutId: id,
        expectedVersion: z.number().int().positive(),
        exerciseId: id,
        set: setSchema,
        completedAt: isoDateTime.optional(),
      }),
      readOnly: false,
      method: 'POST',
      path: '/workouts/:workoutId/sets',
      run: async (args) => {
        const workout = await this.require<Workout>('workout', args.workoutId);
        assert(workout.data.state === 'active', 'WORKOUT_NOT_ACTIVE');
        assert(
          ['reps', 'weightKg', 'durationSeconds', 'distanceMeters'].some(
            (key) => args.set[key] !== undefined,
          ),
          'SET_METRICS_REQUIRED',
        );
        const exerciseSnapshot =
          workout.data.plan?.snapshot.exercises.find(
            (entry) => entry.exerciseId === args.exerciseId,
          )?.exerciseSnapshot ?? (await this.require<Exercise>('exercise', args.exerciseId)).data;
        const set = {
          ...args.set,
          id: crypto.randomUUID(),
          exerciseId: args.exerciseId,
          exerciseSnapshot,
          completedAt: args.completedAt
            ? new Date(args.completedAt).toISOString()
            : new Date().toISOString(),
        };
        const doc = await this.save<Workout>(
          'workout',
          { ...workout.data, sets: [...workout.data.sets, set] },
          { id: workout.id, expectedVersion: args.expectedVersion },
        );
        return this.prepared(doc, args.expectedVersion);
      },
    });
    this.add({
      name: 'revise_workout_set',
      description:
        'Correct an existing set, including after a workout was completed, while retaining revision history.',
      schema: z.object({
        operationId,
        workoutId: id,
        setId: id,
        expectedVersion: z.number().int().positive(),
        set: setSchema,
      }),
      readOnly: false,
      method: 'PUT',
      path: '/workouts/:workoutId/sets/:setId',
      run: async (args) => {
        const old = await this.require<Workout>('workout', args.workoutId);
        assert(
          old.data.sets.some((set) => set.id === args.setId),
          'UNKNOWN_SET',
        );
        assert(
          ['reps', 'weightKg', 'durationSeconds', 'distanceMeters'].some(
            (key) => args.set[key] !== undefined,
          ),
          'SET_METRICS_REQUIRED',
        );
        const sets = old.data.sets.map((set) =>
          set.id === args.setId ? { ...set, ...args.set } : set,
        );
        return this.prepared(
          await this.save<Workout>(
            'workout',
            { ...old.data, sets },
            { id: old.id, expectedVersion: args.expectedVersion },
          ),
          args.expectedVersion,
        );
      },
    });
    for (const [action, state] of [
      ['finish', 'completed'],
      ['cancel', 'cancelled'],
    ] as const) {
      this.add({
        name: `${action}_workout`,
        description: `${action === 'finish' ? 'Complete' : 'Cancel'} an active workout without changing planned targets.`,
        schema: z.object({
          operationId,
          id,
          expectedVersion: z.number().int().positive(),
          finishedAt: isoDateTime.optional(),
        }),
        readOnly: false,
        method: 'POST',
        path: `/workouts/:id/${action}`,
        run: async (args) => {
          const old = await this.require<Workout>('workout', args.id);
          assert(old.data.state === 'active', 'WORKOUT_NOT_ACTIVE');
          const finishedAt = args.finishedAt
            ? new Date(args.finishedAt).toISOString()
            : new Date().toISOString();
          assert(finishedAt >= old.data.startedAt, 'INVALID_WORKOUT_TIME');
          return this.prepared(
            await this.save<Workout>('workout', { ...old.data, state, finishedAt }, args),
            args.expectedVersion,
          );
        },
      });
    }
    this.add({
      name: 'get_exercise_history',
      description:
        'Read historical sets for an exercise, including their original exercise and plan snapshots.',
      schema: z.object({
        exerciseId: id,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      readOnly: true,
      method: 'GET',
      path: '/exercises/:exerciseId/history',
      run: async (args) => {
        const page = await this.repository.list<Workout>(this.actor.ownerId, 'workout', {
          ...args,
          exerciseId: args.exerciseId,
        });
        return {
          ...page,
          items: page.items.map((doc) => ({
            workoutId: doc.id,
            workoutName: doc.data.name,
            startedAt: doc.data.startedAt,
            state: doc.data.state,
            sets: doc.data.sets.filter((set) => set.exerciseId === args.exerciseId),
          })),
        };
      },
    });
    this.add({
      name: 'get_record_revisions',
      description: 'Read saved revisions of a business record for audit and correction.',
      schema: z.object({
        kind: z.enum(['exercise', 'plan', 'workout', 'food', 'recipe', 'meal']),
        id,
      }),
      readOnly: true,
      method: 'GET',
      path: '/history/:kind/:id',
      run: async (args) => ({
        items: await this.repository.revisions(this.actor.ownerId, args.kind, args.id),
      }),
    });
  }
}
