import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { summarizeDay, type DayMeal } from '../src/domain/nutrition';
import type { Nutrients } from '../src/domain/schemas';
import fixture from '../../../packages/OpenFitnessKit/Tests/OpenFitnessKitTests/Fixtures/daily-nutrition-parity.json';

interface FixtureMeal {
  id: string;
  createdAt: string;
  deleted?: boolean;
  occurredAt: string;
  nutrients: Nutrients;
}
interface FixtureCase {
  name: string;
  day: string;
  timeZone: string;
  meals: FixtureMeal[];
  expect: {
    error?: string;
    from?: string;
    to?: string;
    mealCount?: number;
    nutrients?: Nutrients;
  };
}

const cases = fixture.cases as FixtureCase[];

describe('daily nutrition parity', () => {
  for (const item of cases) {
    it(item.name, () => {
      const meals: DayMeal[] = item.meals.map((meal) => ({
        id: meal.id,
        createdAt: meal.createdAt,
        deleted: meal.deleted,
        data: { occurredAt: meal.occurredAt, nutrients: meal.nutrients },
      }));
      if (item.expect.error) {
        expect(() => summarizeDay(meals, item.day, item.timeZone)).toThrow(AppError);
        try {
          summarizeDay(meals, item.day, item.timeZone);
        } catch (error) {
          expect(error).toMatchObject({ code: item.expect.error });
        }
        return;
      }
      expect(summarizeDay(meals, item.day, item.timeZone)).toEqual({
        day: item.day,
        timeZone: item.timeZone,
        from: item.expect.from,
        to: item.expect.to,
        mealCount: item.expect.mealCount,
        nutrients: item.expect.nutrients,
      });
    });
  }
});
