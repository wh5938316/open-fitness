import { canonical } from '../crypto';
import type { Food } from './schemas';

function nutritionShape(food: Food) {
  return {
    nutrients: food.nutrients,
    basis: food.basis,
    servingSize: food.servingSize ?? null,
  };
}

export function nutritionChanged(previous: Food, next: Food): boolean {
  return canonical(nutritionShape(previous)) !== canonical(nutritionShape(next));
}

/** Nutrient, basis, or serving edits of an Open Food Facts food become user data. */
export function applyFoodEdit(previous: Food, next: Food): Food {
  const barcode = next.barcode ?? previous.barcode;
  const edited: Food = barcode ? { ...next, barcode } : { ...next };
  if (!edited.barcode) delete edited.barcode;
  if (previous.source.kind !== 'open_food_facts' || !nutritionChanged(previous, next))
    return edited;
  return {
    ...edited,
    source: {
      ...edited.source,
      kind: 'user',
      reference: edited.source.reference ?? previous.source.reference,
      retrievedAt: edited.source.retrievedAt ?? previous.source.retrievedAt,
      upstreamModifiedAt: edited.source.upstreamModifiedAt ?? previous.source.upstreamModifiedAt,
    },
  };
}
