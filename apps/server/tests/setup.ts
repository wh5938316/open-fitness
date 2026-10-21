import { beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import fixture from './fixtures/catalog-exercises.json';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const statements = fixture.exercises.map((row) =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO catalog_exercises(
        id, external_id, source, catalog_version, data, search_text,
        body_part, equipment, target, movement_category, needs_rewrite, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.externalId,
      row.source,
      row.catalogVersion,
      JSON.stringify(row.data),
      row.searchText,
      row.bodyPart,
      row.equipment,
      row.target,
      row.movementCategory,
      row.needsRewrite ? 1 : 0,
      row.updatedAt,
    ),
  );
  for (const row of fixture.i18n) {
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO catalog_exercise_i18n(
          exercise_id, locale, name, aliases, instructions, provenance
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.exerciseId,
        row.locale,
        row.name,
        JSON.stringify(row.aliases),
        row.instructions ?? null,
        JSON.stringify(row.provenance),
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
});
