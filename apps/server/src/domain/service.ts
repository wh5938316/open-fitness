import { z } from 'zod';
import { canonical, sha256 } from '../crypto';
import { AppError, assert, conflict, notFound } from '../errors';
import { t } from '../i18n';
import type { SyncPublisher } from '../sync/contract';
import type {
  Actor,
  Commit,
  Entity,
  EntityKind,
  MediaReference,
  Mutation,
  Repository,
} from '../types';
import { requireBarcode } from './barcode';
import type { CatalogLookup, CatalogSearch } from './catalog';
import { applyFoodEdit } from './food';
import {
  dayBounds,
  foodNutrition,
  portionIngredients,
  scaleNutrients,
  sumNutrients,
} from './nutrition';
import {
  canonicalCatalogId,
  decodeExerciseCursor,
  emptyExerciseCatalog,
  encodeExerciseCursor,
  exerciseTaxonomy,
  isCatalogExerciseId,
  presentExercise,
  virtualExercise,
  type ExerciseCatalog,
} from './exercise-catalog';
import {
  bodyPartValues,
  deleteSchema,
  exerciseSchema,
  foodSchema,
  getSchema,
  id,
  ingredientSchema,
  ingredientsSchema,
  isoDateTime,
  listSchema,
  movementCategoryValues,
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
  lookup(barcode: string): Promise<CatalogLookup>;
  search(query: string): Promise<CatalogSearch>;
  refresh(barcode: string): Promise<Food>;
}
export interface Prepared {
  response: unknown;
  mutations: Mutation[];
  exports?: Commit['exports'];
  mediaReferences?: MediaReference[];
  ownerUpdate?: Commit['ownerUpdate'];
  uploadTicket?: Commit['uploadTicket'];
  healthMutation?: Commit['healthMutation'];
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
    private exerciseCatalog: ExerciseCatalog = emptyExerciseCatalog,
    private publisher?: SyncPublisher,
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
    return this.finish(operation, args, requestHash);
  }
  private async finish(
    operation: Operation,
    args: Record<string, unknown>,
    requestHash: string,
    attempt = 0,
  ): Promise<unknown> {
    try {
      const result = await operation.run(args);
      if (!isPrepared(result)) return result;
      const response = await this.repository.commit({
        actor: this.actor,
        operation: operation.name,
        operationId: String(args.operationId),
        requestHash,
        ...result,
      });
      await this.publishMutations(result.mutations);
      return response;
    } catch (error) {
      if (attempt < 2 && error instanceof AppError && error.code === 'FOOD_BARCODE_EXISTS')
        return this.finish(operation, args, requestHash, attempt + 1);
      throw error;
    }
  }
  async require<T>(kind: EntityKind, entityId: string): Promise<Entity<T>> {
    const doc = await this.repository.get<T>(this.actor.ownerId, kind, entityId);
    if (!doc) throw notFound();
    return doc;
  }
  private async requireVersion<T>(
    kind: EntityKind,
    entityId: string,
    version?: number,
  ): Promise<Entity<T>> {
    const current = await this.require<T>(kind, entityId);
    if (version === undefined || version === current.version) return current;
    const revisions = (await this.repository.revisions(this.actor.ownerId, kind, entityId)) as {
      version: number;
      data: T;
      deleted: boolean;
      createdAt: string;
    }[];
    const revision = revisions.find((item) => item.version === version && !item.deleted);
    if (!revision) throw notFound();
    return { ...current, version, data: revision.data, updatedAt: revision.createdAt };
  }
  async save<T>(
    kind: EntityKind,
    data: T,
    input: { id?: string; expectedVersion?: number },
  ): Promise<Entity<T>> {
    if (input.id) {
      const existing = await this.repository.getAny<T>(this.actor.ownerId, kind, input.id);
      if (!existing) {
        assert(input.expectedVersion === undefined, 'UNEXPECTED_VERSION');
        if (kind === 'exercise' && isCatalogExerciseId(input.id))
          throw new AppError(422, 'CATALOG_ID_RESERVED', 'invalidInput');
        const now = new Date().toISOString();
        return { id: input.id, kind, version: 1, data, createdAt: now, updatedAt: now };
      }
      assert(input.expectedVersion !== undefined, 'EXPECTED_VERSION_REQUIRED');
      const old = await this.require<T>(kind, input.id);
      if (old.version !== input.expectedVersion) throw conflict();
      return { ...old, version: old.version + 1, data, updatedAt: new Date().toISOString() };
    }
    assert(input.expectedVersion === undefined, 'UNEXPECTED_VERSION');
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), kind, version: 1, data, createdAt: now, updatedAt: now };
  }
  private async publishMutations(mutations: Mutation[]): Promise<void> {
    if (!this.publisher || mutations.length === 0) return;
    try {
      await this.publisher.publish(mutations.map((item) => item.entity));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'sync_publish_failed',
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        }),
      );
    }
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
  async resolveIngredients(
    inputs: IngredientInput[],
    adopt: boolean,
  ): Promise<{ ingredients: Ingredient[]; adopted: Entity<Food>[] }> {
    const adopted: Entity<Food>[] = [];
    const pending = new Map<string, Entity<Food>>();
    const lookedUp = new Map<string, Food>();
    const ingredients: Ingredient[] = [];
    for (const input of inputs) {
      let food: Food;
      let foodId = input.foodId;
      if (foodId) {
        food = (await this.require<Food>('food', foodId)).data;
      } else if (input.catalogBarcode) {
        const code = requireBarcode(input.catalogBarcode);
        const existing =
          pending.get(code) ??
          (await this.repository.findFoodByBarcode<Food>(this.actor.ownerId, code));
        if (existing) {
          food = existing.data;
          foodId = existing.id;
        } else if (lookedUp.has(code) && !adopt) {
          food = lookedUp.get(code)!;
          foodId = undefined;
        } else {
          const found = await this.catalog.lookup(code);
          if (!found.food) throw notFound();
          food = found.food;
          if (adopt) {
            const doc = await this.save<Food>('food', food, {});
            pending.set(code, doc);
            adopted.push(doc);
            food = doc.data;
            foodId = doc.id;
          } else {
            lookedUp.set(code, food);
            foodId = undefined;
          }
        }
      } else {
        food = input.food!;
      }
      ingredients.push({
        id: input.id ?? crypto.randomUUID(),
        foodId,
        label: input.label ?? food.name,
        quantity: input.quantity,
        unit: input.unit,
        food: structuredClone(food),
        nutrients: foodNutrition(food, input.quantity, input.unit),
      });
    }
    assert(
      new Set(ingredients.map((item) => item.id)).size === ingredients.length,
      'DUPLICATE_INGREDIENT',
    );
    return { ingredients, adopted };
  }
  private adopt(prepared: Prepared, adopted: Entity<Food>[]): Prepared {
    if (!adopted.length) return prepared;
    const response =
      prepared.response && typeof prepared.response === 'object'
        ? { ...(prepared.response as Record<string, unknown>), adoptedFoods: adopted }
        : prepared.response;
    return {
      ...prepared,
      response,
      mutations: [...adopted.map((entity) => ({ entity })), ...prepared.mutations],
    };
  }
  async readyAsset(assetId: string | null | undefined): Promise<void> {
    if (!assetId) return;
    const asset = await this.require<{ status: string }>('asset', assetId);
    assert(asset.data.status === 'ready', 'ASSET_NOT_READY');
  }
  async addIngredients(
    base: Ingredient[],
    additions: IngredientInput[],
  ): Promise<{ ingredients: Ingredient[]; adopted: Entity<Food>[] }> {
    const extra = await this.resolveIngredients(additions, true);
    const ingredients = [...base, ...extra.ingredients];
    assert(ingredients.length <= 100, 'TOO_MANY_INGREDIENTS');
    assert(
      new Set(ingredients.map((item) => item.id)).size === ingredients.length,
      'DUPLICATE_INGREDIENT',
    );
    return { ingredients, adopted: extra.adopted };
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
  private async searchExercises(args: {
    query?: string;
    cursor?: string;
    limit: number;
    source?: 'all' | 'mine' | 'catalog';
    bodyPart?: (typeof bodyPartValues)[number];
    equipment?: string;
    target?: string;
    movementCategory?: (typeof movementCategoryValues)[number];
  }) {
    const limit = args.limit;
    const source = args.source ?? 'all';
    const filters = {
      query: args.query?.trim() || undefined,
      bodyPart: args.bodyPart,
      equipment: args.equipment,
      target: args.target,
      movementCategory: args.movementCategory,
    };
    let cursor: ReturnType<typeof decodeExerciseCursor> | undefined;
    if (args.cursor?.trim()) {
      try {
        cursor = decodeExerciseCursor(args.cursor);
      } catch {
        throw new AppError(422, 'INVALID_CURSOR');
      }
    }
    if (source !== 'catalog' && (!cursor || cursor.phase === 'mine')) {
      const owned = await this.repository.searchOwnedExercises<Exercise>(this.actor.ownerId, {
        ...filters,
        limit,
        ...(cursor?.phase === 'mine' ? { cursor: { date: cursor.date, id: cursor.id } } : {}),
      });
      if (source === 'mine') {
        return {
          items: owned.items,
          cursor: owned.cursor
            ? encodeExerciseCursor({ phase: 'mine', date: owned.cursor.date, id: owned.cursor.id })
            : null,
        };
      }
      if (owned.cursor) {
        return {
          items: owned.items,
          cursor: encodeExerciseCursor({
            phase: 'mine',
            date: owned.cursor.date,
            id: owned.cursor.id,
          }),
        };
      }
      const remaining = limit - owned.items.length;
      if (remaining <= 0) {
        return { items: owned.items, cursor: encodeExerciseCursor({ phase: 'catalog' }) };
      }
      const catalog = await this.exerciseCatalog.search({
        ...filters,
        ownerId: this.actor.ownerId,
        limit: remaining,
      });
      return {
        items: [
          ...owned.items,
          ...catalog.items.map((item) => virtualExercise(item, this.actor.locale)),
        ],
        cursor: catalog.cursor
          ? encodeExerciseCursor({ phase: 'catalog', ...catalog.cursor })
          : null,
      };
    }
    const catalogCursor = cursor?.phase === 'catalog' && 'mode' in cursor ? cursor : undefined;
    const catalog = await this.exerciseCatalog.search({
      ...filters,
      ownerId: this.actor.ownerId,
      limit,
      cursor: catalogCursor,
    });
    return {
      items: catalog.items.map((item) => virtualExercise(item, this.actor.locale)),
      cursor: catalog.cursor ? encodeExerciseCursor({ phase: 'catalog', ...catalog.cursor }) : null,
    };
  }
  private async readExercise(exerciseId: string) {
    const owned = await this.repository.get<Exercise>(this.actor.ownerId, 'exercise', exerciseId);
    if (owned) return owned;
    const catalogId = canonicalCatalogId(exerciseId);
    if (!catalogId || !isCatalogExerciseId(catalogId)) throw notFound();
    const record = await this.exerciseCatalog.get(catalogId);
    if (!record) throw notFound();
    return virtualExercise(record, this.actor.locale);
  }
  private async resolveExerciseForWrite(
    exerciseId: string,
    pending: Map<string, { entity: Entity<Exercise>; expectedVersion?: number }>,
  ): Promise<{
    snapshot: Exercise;
    adoption?: { entity: Entity<Exercise>; expectedVersion?: number };
  }> {
    const already = pending.get(exerciseId);
    if (already) return { snapshot: already.entity.data };
    const owned = await this.repository.get<Exercise>(this.actor.ownerId, 'exercise', exerciseId);
    if (owned) return { snapshot: owned.data };
    const catalogId = canonicalCatalogId(exerciseId);
    if (!catalogId || !isCatalogExerciseId(catalogId)) throw notFound();
    const record = await this.exerciseCatalog.get(catalogId);
    if (!record) throw notFound();
    const data = presentExercise(record.data, this.actor.locale, record.i18n);
    const raw = await this.repository.getAny<Exercise>(this.actor.ownerId, 'exercise', catalogId);
    const now = new Date().toISOString();
    if (raw?.deleted) {
      const { deleted: _deleted, ...rest } = raw;
      const adoption = {
        entity: { ...rest, version: raw.version + 1, data, updatedAt: now },
        expectedVersion: raw.version,
      };
      pending.set(catalogId, adoption);
      return { snapshot: data, adoption };
    }
    if (raw) return { snapshot: raw.data };
    const adoption = {
      entity: {
        id: catalogId,
        kind: 'exercise' as const,
        version: 1,
        data,
        createdAt: now,
        updatedAt: now,
      },
    };
    pending.set(catalogId, adoption);
    return { snapshot: data, adoption };
  }
  private withAdoptions(
    prepared: Prepared,
    adopted: { entity: Entity<Exercise>; expectedVersion?: number }[],
  ): Prepared {
    if (!adopted.length) return prepared;
    const response =
      prepared.response && typeof prepared.response === 'object'
        ? {
            ...(prepared.response as Record<string, unknown>),
            adoptedExercises: adopted.map((item) => item.entity),
          }
        : prepared.response;
    return {
      ...prepared,
      response,
      mutations: [
        ...adopted.map((item) => ({ entity: item.entity, expectedVersion: item.expectedVersion })),
        ...prepared.mutations,
      ],
    };
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
        instructionsVersion: '2',
        instructions: t(this.actor.locale, 'botInstructions'),
        exerciseCatalogAttribution: t(this.actor.locale, 'exerciseCatalogAttribution'),
        capabilities: {
          healthSyncProtocol: 1,
          training: true,
          recipes: true,
          meals: true,
          media: true,
          healthExport: 'awaiting_device',
          healthImport: false,
          imageProcessing: 'provided_by_agent',
          foodCatalog: 'cached_open_food_facts',
          exerciseCatalog: 'shared_catalog',
          localSync: 'tinybase',
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
        'Inspect Apple Health export events and their device delivery states. Awaiting events require an enrolled native iPhone.',
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
        description:
          kind === 'exercise'
            ? 'Read one exercise. A cat- id returns the owner copy when it exists, otherwise the shared catalogue record at version 0.'
            : `Read one ${kind} and its current version.`,
        schema: getSchema,
        readOnly: true,
        method: 'GET',
        path: `/${plural}/:id`,
        run: async (args) =>
          kind === 'exercise' ? this.readExercise(args.id) : this.require(kind, args.id),
      });
      if (kind === 'food') {
        this.add({
          name: 'search_foods',
          description:
            "List or search this owner's foods by name, alias, or barcode. Set includeCatalog to add Open Food Facts matches that are not already saved, under catalog.items. catalog.catalogStatus is degraded when upstream is unavailable.",
          schema: listSchema.extend({ includeCatalog: z.boolean().default(false) }),
          readOnly: true,
          method: 'GET',
          path: '/foods',
          run: async (args) => {
            const page = await this.repository.list(this.actor.ownerId, 'food', args);
            if (!args.includeCatalog) return page;
            const query = args.query?.trim() ?? '';
            if (query.length < 2)
              return { ...page, catalog: { items: [], catalogStatus: 'ok' as const } };
            const catalog = await this.catalog.search(query);
            const owned = new Set(await this.repository.listFoodBarcodes(this.actor.ownerId));
            return {
              ...page,
              catalog: {
                items: catalog.items.filter((food) => !food.barcode || !owned.has(food.barcode)),
                catalogStatus: catalog.catalogStatus,
              },
            };
          },
        });
      } else if (kind === 'exercise') {
        this.add({
          name: 'search_exercises',
          description:
            "List or search this owner's exercises together with the shared catalogue. Owner rows come first. source=mine or source=catalog limits the union. Optional filters are bodyPart, equipment, target, and movementCategory. Catalogue rows use cat- ids and version 0 until adopted.",
          schema: listSchema.extend({
            source: z.preprocess(
              (value) => (value === '' || value === undefined ? 'all' : value),
              z.enum(['all', 'mine', 'catalog']),
            ),
            bodyPart: z.preprocess(
              (value) => (value === '' ? undefined : value),
              z.enum(bodyPartValues).optional(),
            ),
            equipment: z.preprocess(
              (value) => (value === '' ? undefined : value),
              z.string().max(80).optional(),
            ),
            target: z.preprocess(
              (value) => (value === '' ? undefined : value),
              z.string().max(80).optional(),
            ),
            movementCategory: z.preprocess(
              (value) => (value === '' ? undefined : value),
              z.enum(movementCategoryValues).optional(),
            ),
          }),
          readOnly: true,
          method: 'GET',
          path: '/exercises',
          run: async (args) => this.searchExercises(args),
        });
      } else {
        this.add({
          name: kind === 'recipe' ? 'search_recipes' : `list_${suffix}s`,
          description: `List or search your ${plural} using cursor pagination.`,
          schema: listSchema,
          readOnly: true,
          method: 'GET',
          path: `/${plural}`,
          run: async (args) => this.repository.list(this.actor.ownerId, kind, args),
        });
      }
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
        description:
          kind === 'food'
            ? 'Create or update a food. Supply expectedVersion when updating. Editing nutrients, basis, or serving size of an Open Food Facts food changes source.kind to user and keeps the barcode. Renames, aliases, and notes do not. Nutrition estimates must include their basis.'
            : `Create or update a ${kind}. Supply expectedVersion when updating. Nutrition estimates must include their basis.`,
        schema: z.object({ ...mutation, data: schema }),
        readOnly: false,
        method: 'POST',
        path,
        run: async (args) => {
          let data = args.data;
          if (kind === 'exercise') {
            if (args.data.source?.kind === 'catalog')
              throw new AppError(422, 'CATALOG_SOURCE_RESERVED', 'invalidInput');
            if (typeof args.id === 'string' && args.id.startsWith('cat-')) {
              const existing = await this.repository.getAny<Exercise>(
                this.actor.ownerId,
                'exercise',
                args.id,
              );
              if (!existing || existing.deleted)
                throw new AppError(422, 'CATALOG_ID_RESERVED', 'invalidInput');
            }
            for (const assetId of args.data.mediaAssetIds) await this.readyAsset(assetId);
            if (args.id) {
              const current = await this.repository.get<Exercise>(
                this.actor.ownerId,
                'exercise',
                args.id,
              );
              if (current) {
                if (current.version !== args.expectedVersion) throw conflict();
                if (current.data.source?.kind === 'catalog' || data.source) {
                  data = {
                    ...data,
                    source: { ...current.data.source, ...data.source, kind: 'user' },
                  };
                }
              }
            }
          }
          if (kind === 'food' && args.id) {
            const current = await this.repository.get<Food>(this.actor.ownerId, 'food', args.id);
            if (current) {
              if (current.version !== args.expectedVersion) throw conflict();
              data = applyFoodEdit(current.data, args.data);
            }
          }
          const doc = await this.save(kind, data, args);
          return this.prepared(doc, args.expectedVersion);
        },
      });
    }
    this.add({
      name: 'adopt_exercise',
      description:
        'Copy a shared catalogue exercise into this owner. Repeating the adoption returns the existing exercise. A soft-deleted copy is restored from the current catalogue entry. Overrides require expectedVersion.',
      schema: z.object({
        operationId,
        id,
        expectedVersion: z.number().int().positive().optional(),
        overrides: z
          .object({
            name: z.string().min(1).max(200).optional(),
            aliases: z.array(z.string().max(200)).max(30).optional(),
            instructions: z.string().max(20000).optional(),
            notes: z.string().max(10000).optional(),
          })
          .optional(),
      }),
      readOnly: false,
      method: 'POST',
      path: '/exercises/:id/adopt',
      run: async (args) => {
        const catalogId = canonicalCatalogId(args.id);
        if (!catalogId || !isCatalogExerciseId(catalogId)) throw notFound();
        const record = await this.exerciseCatalog.get(catalogId);
        if (!record) throw notFound();
        const current = await this.repository.getAny<Exercise>(
          this.actor.ownerId,
          'exercise',
          catalogId,
        );
        const overrides = args.overrides ?? {};
        const hasOverrides = Object.keys(overrides).length > 0;
        if (current && !current.deleted && !hasOverrides)
          return { response: { exercise: current, created: false }, mutations: [] };
        if (current && !current.deleted && hasOverrides) {
          assert(args.expectedVersion !== undefined, 'EXPECTED_VERSION_REQUIRED');
          if (current.version !== args.expectedVersion) throw conflict();
          const data = { ...current.data, ...overrides };
          const doc = {
            ...current,
            version: current.version + 1,
            data,
            updatedAt: new Date().toISOString(),
          };
          return {
            response: { exercise: doc, created: false },
            mutations: [{ entity: doc, expectedVersion: current.version }],
          };
        }
        const data = {
          ...presentExercise(record.data, this.actor.locale, record.i18n),
          ...overrides,
        };
        const now = new Date().toISOString();
        if (current?.deleted) {
          const { deleted: _deleted, ...rest } = current;
          const doc = {
            ...rest,
            version: current.version + 1,
            data,
            updatedAt: now,
          };
          return {
            response: { exercise: doc, created: true },
            mutations: [{ entity: doc, expectedVersion: current.version }],
          };
        }
        const doc: Entity<Exercise> = {
          id: catalogId,
          kind: 'exercise',
          version: 1,
          data,
          createdAt: now,
          updatedAt: now,
        };
        return { response: { exercise: doc, created: true }, mutations: [{ entity: doc }] };
      },
    });
    this.add({
      name: 'list_exercise_taxonomy',
      description:
        'List body parts, equipment, muscles, and movement categories with labels for the owner locale, plus the body-diagram SVG paths and muscle-region ids.',
      schema: z.object({}),
      readOnly: true,
      method: 'GET',
      path: '/exercise-taxonomy',
      run: async () => ({
        ...exerciseTaxonomy(this.actor.locale),
        attribution: t(this.actor.locale, 'exerciseCatalogAttribution'),
        diagramNote: t(this.actor.locale, 'exerciseDiagramNote'),
      }),
    });
    this.add({
      name: 'lookup_food',
      description:
        "Look up a barcode in this owner's foods, then the Open Food Facts cache, then upstream. localFood is set when the barcode is already saved. A stale cached product is returned when upstream is unavailable. Read-only; use import_food to adopt it.",
      schema: z.object({ barcode: z.string().min(4).max(64) }),
      readOnly: true,
      method: 'GET',
      path: '/food-catalog/:barcode',
      run: async (args) => {
        const code = requireBarcode(args.barcode);
        const localFood = await this.repository.findFoodByBarcode<Food>(this.actor.ownerId, code);
        if (localFood) return { food: localFood.data, localFood, stale: false };
        const found = await this.catalog.lookup(code);
        return {
          food: found.food,
          localFood: null,
          stale: found.stale,
          ...(found.stale ? { catalogStatus: 'degraded' as const } : {}),
        };
      },
    });
    this.add({
      name: 'search_food_catalog',
      description:
        'Deprecated. Use search_foods with includeCatalog instead. Searches the Open Food Facts cache and upstream catalog. When upstream is unavailable, returns cached matches and catalogStatus "degraded".',
      schema: z.object({ query: z.string().min(2).max(200) }),
      readOnly: true,
      method: 'GET',
      path: '/food-catalog',
      run: async (args) => this.catalog.search(args.query),
    });
    this.add({
      name: 'import_food',
      description:
        "Adopt an Open Food Facts product into this owner's foods by barcode. Repeating the import returns the existing food with created false. Twelve-digit UPC-A barcodes match their EAN-13 form.",
      schema: z.object({ operationId, barcode: z.string().min(4).max(64) }),
      readOnly: false,
      method: 'POST',
      path: '/foods/import',
      run: async (args) => {
        const code = requireBarcode(args.barcode);
        const existing = await this.repository.findFoodByBarcode<Food>(this.actor.ownerId, code);
        if (existing) return { response: { food: existing, created: false }, mutations: [] };
        const found = await this.catalog.lookup(code);
        if (!found.food) throw notFound();
        const doc = await this.save<Food>('food', found.food, {});
        const prepared = this.prepared(doc);
        return {
          ...prepared,
          response: { food: doc, created: true, ...(found.stale ? { stale: true } : {}) },
        };
      },
    });
    this.add({
      name: 'refresh_food',
      description:
        'Refresh a saved food from Open Food Facts. if_unmodified returns 409 when source.kind is no longer open_food_facts. overwrite replaces label nutrients and restores open_food_facts provenance while keeping aliases and notes. Meals and recipes are not rewritten.',
      schema: z.object({
        operationId,
        id,
        expectedVersion: z.number().int().positive(),
        mode: z.enum(['if_unmodified', 'overwrite']),
      }),
      readOnly: false,
      method: 'POST',
      path: '/foods/:id/refresh',
      run: async (args) => {
        const current = await this.require<Food>('food', args.id);
        if (current.version !== args.expectedVersion) throw conflict();
        if (!current.data.barcode)
          throw new AppError(422, 'FOOD_BARCODE_REQUIRED', 'invalidBarcode');
        if (args.mode === 'if_unmodified' && current.data.source.kind !== 'open_food_facts')
          throw new AppError(409, 'FOOD_MODIFIED', 'foodModified');
        const latest = await this.catalog.refresh(current.data.barcode);
        const data: Food = {
          ...current.data,
          name: latest.name,
          nutrients: latest.nutrients,
          basis: latest.basis,
          barcode: current.data.barcode,
          source: {
            kind: 'open_food_facts',
            reference: latest.source.reference ?? current.data.source.reference,
            basis: latest.source.basis,
            retrievedAt: latest.source.retrievedAt,
            upstreamModifiedAt: latest.source.upstreamModifiedAt,
          },
        };
        if (latest.servingSize) data.servingSize = latest.servingSize;
        else delete data.servingSize;
        return this.prepared(
          await this.save<Food>('food', data, { id: current.id, expectedVersion: current.version }),
          current.version,
        );
      },
    });
    this.add({
      name: 'calculate_nutrition',
      description:
        'Calculate nutrition from food IDs, catalogBarcode values, or explicit food snapshots and quantities. catalogBarcode is resolved read-only and is not saved. Unknown nutrients remain null.',
      schema: z.object({ ingredients: ingredientsSchema }),
      readOnly: true,
      method: 'POST',
      path: '/nutrition/calculate',
      run: async (args) => {
        const { ingredients } = await this.resolveIngredients(args.ingredients, false);
        return { ingredients, nutrients: sumNutrients(ingredients.map((item) => item.nutrients)) };
      },
    });
    this.add({
      name: 'save_training_plan',
      description:
        'Create or revise a training plan, including exercise snapshots, target sets, rest periods, and superset groups. A cat- exercise id is adopted into this owner in the same transaction.',
      schema: z.object({ ...mutation, data: planSchema }),
      readOnly: false,
      method: 'POST',
      path: '/training-plans',
      run: async (args) => {
        const pending = new Map<string, { entity: Entity<Exercise>; expectedVersion?: number }>();
        const exercises = [];
        for (const entry of args.data.exercises) {
          const resolved = await this.resolveExerciseForWrite(entry.exerciseId, pending);
          exercises.push({ ...entry, exerciseSnapshot: resolved.snapshot });
        }
        const doc = await this.save<Plan>('plan', { ...args.data, exercises }, args);
        return this.withAdoptions(this.prepared(doc, args.expectedVersion), [...pending.values()]);
      },
    });
    this.add({
      name: 'save_recipe',
      description:
        'Create a reusable recipe or restaurant meal template. Quantities describe the entire batch; yield.servings defines standard portions. Updating affects future meals only. An ingredient catalogBarcode adopts that product into foods in the same transaction.',
      schema: z.object({ ...mutation, data: recipeSchema }),
      readOnly: false,
      method: 'POST',
      path: '/recipes',
      run: async (args) => {
        await this.readyAsset(args.data.coverAssetId);
        await this.readyAsset(args.data.coverThumbnailAssetId);
        const resolved = await this.resolveIngredients(args.data.ingredients, true);
        const ingredients = resolved.ingredients;
        const nutrients = sumNutrients(ingredients.map((item) => item.nutrients));
        const previous = args.id
          ? await this.repository.get<Recipe>(this.actor.ownerId, 'recipe', args.id)
          : null;
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
        return this.adopt(
          this.prepared(doc, args.expectedVersion, {
            mediaReferences: [
              {
                assetId: data.coverAssetId ?? null,
                targetKind: 'recipe',
                targetId: doc.id,
                slot: 'cover',
              },
            ],
          }),
          resolved.adopted,
        );
      },
    });
    this.add({
      name: 'log_meal',
      description:
        'Record an actual meal from ingredient quantities and save an immutable nutrition snapshot. An ingredient catalogBarcode adopts that product into foods in the same transaction.',
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
        const resolved = await this.resolveIngredients(args.ingredients, true);
        const ingredients = resolved.ingredients;
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
        return this.adopt(this.mealPrepared(doc), resolved.adopted);
      },
    });
    this.add({
      name: 'log_meal_from_recipe',
      description:
        'Log a saved recipe by servings or cooked grams without reanalyzing it. Overrides replace absolute ingredient amounts after scaling; additions apply only to this meal. An addition catalogBarcode adopts that product into foods in the same transaction.',
      schema: z.object({
        operationId,
        recipeId: id,
        recipeVersion: z.number().int().positive().optional(),
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
        const recipe = await this.requireVersion<Recipe>(
          'recipe',
          args.recipeId,
          args.recipeVersion,
        );
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
        const resolved = await this.addIngredients(portion, args.additions);
        const ingredients = resolved.ingredients;
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
        return this.adopt(this.mealPrepared(doc), resolved.adopted);
      },
    });
    this.add({
      name: 'revise_meal',
      description:
        'Correct one recorded meal. This does not modify its source recipe or other meals. An ingredient or addition catalogBarcode adopts that product into foods in the same transaction.',
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
        let adopted: Entity<Food>[] = [];
        let ingredients: Ingredient[];
        if (args.ingredients) {
          const resolved = await this.resolveIngredients(args.ingredients, true);
          ingredients = resolved.ingredients;
          adopted = resolved.adopted;
        } else {
          const base = portionIngredients(old.data.ingredients, 1, args.overrides ?? []);
          const resolved = await this.addIngredients(base, args.additions);
          ingredients = resolved.ingredients;
          adopted = resolved.adopted;
        }
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
        return this.adopt(
          this.mealPrepared(await this.save<Meal>('meal', data, args), args.expectedVersion),
          adopted,
        );
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
        planVersion: z.number().int().positive().optional(),
        name: z.string().max(200).optional(),
        startedAt: isoDateTime.optional(),
        source: z.enum(['ios', 'watch', 'bot']).default('bot'),
        notes,
      }),
      readOnly: false,
      method: 'POST',
      path: '/workouts',
      run: async (args) => {
        const plan = args.planId
          ? await this.requireVersion<Plan>('plan', args.planId, args.planVersion)
          : null;
        const data: Workout = {
          source: args.source,
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
        'Append an actual set, including exercise snapshot, reps, load, duration, distance, and optional effort. A cat- exercise id that is not already on the workout plan is adopted in the same transaction.',
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
        const planned = workout.data.plan?.snapshot.exercises.find(
          (entry) => entry.exerciseId === args.exerciseId,
        )?.exerciseSnapshot;
        const pending = new Map<string, { entity: Entity<Exercise>; expectedVersion?: number }>();
        const exerciseSnapshot = planned
          ? planned
          : (await this.resolveExerciseForWrite(args.exerciseId, pending)).snapshot;
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
        return this.withAdoptions(this.prepared(doc, args.expectedVersion), [...pending.values()]);
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
