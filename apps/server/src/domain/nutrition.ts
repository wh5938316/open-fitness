import { AppError, assert } from '../errors';
import { nutrientKeys, type Food, type Ingredient, type Nutrients } from './schemas';

export function scaleNutrients(nutrients: Nutrients, factor: number): Nutrients {
  return Object.fromEntries(
    nutrientKeys.map((key) => [
      key,
      factor === 0 ? 0 : nutrients[key] === null ? null : round(nutrients[key] * factor),
    ]),
  ) as Nutrients;
}
export function sumNutrients(items: Nutrients[]): Nutrients {
  return Object.fromEntries(
    nutrientKeys.map((key) => [
      key,
      items.some((item) => item[key] === null)
        ? null
        : round(items.reduce((sum, item) => sum + (item[key] ?? 0), 0)),
    ]),
  ) as Nutrients;
}
function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
export function foodNutrition(food: Food, amount: number, unit: 'g' | 'ml' | 'serving'): Nutrients {
  if (amount === 0) return scaleNutrients(food.nutrients, 0);
  let resolvedUnit = unit;
  let resolvedAmount = amount;
  let basisUnit = food.basis.unit;
  let basisAmount = food.basis.quantity;
  if (resolvedUnit !== basisUnit && (resolvedUnit === 'serving' || basisUnit === 'serving')) {
    if (!food.servingSize)
      throw new AppError(422, 'MISSING_CONVERSION', 'missingData', {
        food: food.name,
        required: 'servingSize',
      });
    if (resolvedUnit === 'serving') {
      resolvedAmount *= food.servingSize.quantity;
      resolvedUnit = food.servingSize.unit;
    }
    if (basisUnit === 'serving') {
      basisAmount *= food.servingSize.quantity;
      basisUnit = food.servingSize.unit;
    }
  }
  if (resolvedUnit !== basisUnit) {
    if (!food.densityGPerMl)
      throw new AppError(422, 'MISSING_CONVERSION', 'missingData', {
        food: food.name,
        from: resolvedUnit,
        to: basisUnit,
        required: 'densityGPerMl',
      });
    resolvedAmount =
      resolvedUnit === 'g'
        ? resolvedAmount / food.densityGPerMl
        : resolvedAmount * food.densityGPerMl;
  }
  const result = scaleNutrients(food.nutrients, resolvedAmount / basisAmount);
  assert(
    Object.values(result).every((v) => v === null || Number.isFinite(v)),
    'INVALID_NUTRITION',
  );
  return result;
}
export function portionIngredients(
  ingredients: Ingredient[],
  factor: number,
  overrides: { ingredientId: string; quantity: number; unit?: 'g' | 'ml' | 'serving' }[] = [],
): Ingredient[] {
  assert(
    new Set(overrides.map((item) => item.ingredientId)).size === overrides.length,
    'DUPLICATE_OVERRIDE',
  );
  for (const override of overrides)
    assert(
      ingredients.some((item) => item.id === override.ingredientId),
      'UNKNOWN_INGREDIENT',
      { ingredientId: override.ingredientId },
    );
  return ingredients.map((item) => {
    const override = overrides.find((value) => value.ingredientId === item.id);
    const quantity = override?.quantity ?? item.quantity * factor;
    const unit = override?.unit ?? item.unit;
    return { ...item, quantity, unit, nutrients: foodNutrition(item.food, quantity, unit) };
  });
}
export function dayBounds(day: string, timeZone: string): { from: string; to: string } {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(day), 'INVALID_DATE');
  const nominal = new Date(day + 'T00:00:00Z');
  assert(
    !Number.isNaN(nominal.valueOf()) && nominal.toISOString().slice(0, 10) === day,
    'INVALID_DATE',
  );
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new AppError(422, 'INVALID_TIME_ZONE');
  }
  const midnight = (target: number) => {
    let guess = target;
    for (let i = 0; i < 5; i++) {
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
      );
      const represented = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      const next = guess + target - represented;
      if (next === guess) return new Date(guess).toISOString();
      guess = next;
    }
    throw new AppError(422, 'UNRESOLVABLE_LOCAL_DATE');
  };
  return { from: midnight(nominal.valueOf()), to: midnight(nominal.valueOf() + 86400000) };
}
