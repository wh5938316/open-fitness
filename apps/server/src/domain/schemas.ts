import { z } from 'zod';
import { barcodeFromReference, normalizeBarcode } from './barcode';

export const id = z.string().min(1).max(128);
export const operationId = z.string().min(8).max(128);
export const mutation = {
  operationId,
  id: id.optional(),
  expectedVersion: z.number().int().positive().optional(),
};
export const listSchema = z.object({
  query: z.string().max(200).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export const getSchema = z.object({ id });
export const deleteSchema = z.object({
  operationId,
  id,
  expectedVersion: z.number().int().positive(),
});
export const notes = z.string().max(10000).default('');
export const isoDateTime = z.iso.datetime({ offset: true });
export const quantity = z.number().finite().nonnegative();
export const positive = z.number().finite().positive();
export const unit = z.enum(['g', 'ml', 'serving']);
export const nutrientKeys = ['energyKcal', 'proteinG', 'carbohydrateG', 'fatG', 'fiberG'] as const;
export const nutrientsSchema = z.object({
  energyKcal: quantity.nullable().default(null),
  proteinG: quantity.nullable().default(null),
  carbohydrateG: quantity.nullable().default(null),
  fatG: quantity.nullable().default(null),
  fiberG: quantity.nullable().default(null),
});
const absentString = z
  .string()
  .max(64)
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });
const foodObject = z
  .object({
    name: z.string().min(1).max(200),
    aliases: z.array(z.string().max(200)).max(30).default([]),
    barcode: absentString,
    nutrients: nutrientsSchema,
    basis: z.object({ quantity: positive, unit }),
    servingSize: z.object({ quantity: positive, unit: z.enum(['g', 'ml']) }).optional(),
    densityGPerMl: positive.optional(),
    preparation: z.enum(['raw', 'cooked', 'as_sold']).default('as_sold'),
    source: z.object({
      kind: z.enum(['open_food_facts', 'user', 'bot_estimate']),
      reference: z
        .string()
        .max(2000)
        .nullish()
        .transform((value) => value ?? undefined),
      basis: z
        .string()
        .max(4000)
        .nullish()
        .transform((value) => value ?? undefined),
      retrievedAt: isoDateTime.nullish().transform((value) => value ?? undefined),
      upstreamModifiedAt: isoDateTime.nullish().transform((value) => value ?? undefined),
    }),
    notes,
  })
  .superRefine((food, ctx) => {
    if (food.barcode && !normalizeBarcode(food.barcode))
      ctx.addIssue({ code: 'custom', path: ['barcode'], message: 'Invalid barcode.' });
    if (food.source.kind === 'bot_estimate' && !food.source.basis?.trim())
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'basis'],
        message: 'An estimate must explain its basis.',
      });
    if (
      food.source.kind === 'open_food_facts' &&
      !(food.barcode && normalizeBarcode(food.barcode)) &&
      !barcodeFromReference(food.source.reference)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['barcode'],
        message: 'Open Food Facts foods require a barcode.',
      });
  });
export const foodSchema = foodObject.transform((food) => {
  const barcode =
    (food.barcode ? normalizeBarcode(food.barcode) : null) ??
    (food.source.kind === 'open_food_facts' ? barcodeFromReference(food.source.reference) : null);
  if (!barcode) {
    const rest = { ...food };
    delete rest.barcode;
    return rest;
  }
  return { ...food, barcode };
});
export const ingredientSchema = z
  .object({
    id: id.nullish().transform((value) => value ?? undefined),
    foodId: id.nullish().transform((value) => value ?? undefined),
    food: foodSchema.optional(),
    catalogBarcode: absentString,
    label: z
      .string()
      .max(200)
      .nullish()
      .transform((value) => value ?? undefined),
    quantity: positive,
    unit,
  })
  .refine((value) => Boolean(value.foodId || value.food || value.catalogBarcode), {
    message: 'Provide foodId, catalogBarcode, or an explicit food snapshot.',
  });
export const ingredientsSchema = z.array(ingredientSchema).min(1).max(100);
export const overrideSchema = z.object({ ingredientId: id, quantity, unit: unit.optional() });
export const recipeSchema = z.object({
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().max(200)).max(30).default([]),
  restaurant: z.string().max(200).optional(),
  specification: z.string().max(200).optional(),
  ingredients: ingredientsSchema,
  yield: z.object({ servings: positive.default(1), cookedWeightGrams: positive.optional() }),
  defaultServings: positive.default(1),
  coverAssetId: id.nullable().optional(),
  coverThumbnailAssetId: id.nullable().optional(),
  notes,
});
export const setMetrics = {
  reps: z.number().int().nonnegative().optional(),
  weightKg: quantity.optional(),
  durationSeconds: quantity.optional(),
  distanceMeters: quantity.optional(),
  rpe: z.number().min(0).max(10).optional(),
  rir: z.number().min(0).max(10).optional(),
  type: z.enum(['working', 'warmup', 'drop', 'rest_pause', 'failure']).default('working'),
  groupId: id.optional(),
  notes,
};
export const setSchema = z.object(setMetrics);
export const exerciseSchema = z.object({
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().max(200)).default([]),
  category: z.enum(['strength', 'duration', 'distance', 'mixed']).default('strength'),
  instructions: z.string().max(20000).default(''),
  muscleGroups: z.array(z.string().max(100)).max(30).default([]),
  equipment: z.array(z.string().max(100)).max(30).default([]),
  mediaAssetIds: z.array(id).max(10).default([]),
  notes,
});
export const planSchema = z.object({
  name: z.string().min(1).max(200),
  notes,
  exercises: z
    .array(
      z.object({
        exerciseId: id,
        sets: z.array(setSchema).min(1).max(100),
        restSeconds: quantity.default(90),
        groupId: id.optional(),
        notes,
      }),
    )
    .min(1)
    .max(100),
});
export type Nutrients = z.infer<typeof nutrientsSchema>;
export type Food = z.infer<typeof foodSchema>;
export type IngredientInput = z.infer<typeof ingredientSchema>;
export type Ingredient = {
  id: string;
  foodId?: string;
  label: string;
  quantity: number;
  unit: z.infer<typeof unit>;
  food: Food;
  nutrients: Nutrients;
};
export interface Recipe extends Omit<z.infer<typeof recipeSchema>, 'ingredients'> {
  nutritionVersion: number;
  ingredients: Ingredient[];
  nutrients: Nutrients;
  perServing: Nutrients;
  per100g: Nutrients | null;
}
export interface Meal {
  occurredAt: string;
  notes: string;
  ingredients: Ingredient[];
  nutrients: Nutrients;
  recipe?: { id: string; version: number; servings: number; snapshot: Recipe };
  imageAssetId?: string | null;
}
export type Exercise = z.infer<typeof exerciseSchema>;
export interface Plan extends Omit<z.infer<typeof planSchema>, 'exercises'> {
  exercises: (z.infer<typeof planSchema>['exercises'][number] & { exerciseSnapshot: Exercise })[];
}
export interface Workout {
  name: string;
  state: 'active' | 'completed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  notes: string;
  source?: 'ios' | 'watch' | 'bot';
  plan?: { id: string; version: number; snapshot: Plan };
  sets: (z.infer<typeof setSchema> & {
    id: string;
    exerciseId: string;
    exerciseSnapshot: Exercise;
    completedAt: string;
  })[];
}
