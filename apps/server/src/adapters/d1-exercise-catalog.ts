import { containsLike, prefixLike } from '../domain/search';
import type {
  CatalogExercise,
  CatalogSearchOptions,
  CatalogSearchPage,
  ExerciseCatalog,
  ExerciseTranslation,
} from '../domain/exercise-catalog';
import type { Exercise } from '../domain/schemas';

interface ExerciseRow {
  id: string;
  external_id: string;
  source: 'exercisedb' | 'opengym';
  catalog_version: number;
  data: string;
  updated_at: string;
  needs_rewrite: number;
  zh_name: string | null;
  zh_aliases: string | null;
  zh_description: string | null;
  zh_instructions: string | null;
  zh_provenance: string | null;
  sort_name?: string;
  match_rank?: number;
  name_len?: number;
}

const columns = `catalog_exercises.id, catalog_exercises.external_id, catalog_exercises.source,
  catalog_exercises.catalog_version, catalog_exercises.data, catalog_exercises.updated_at,
  catalog_exercises.needs_rewrite,
  i.name AS zh_name, i.aliases AS zh_aliases, i.description AS zh_description,
  i.instructions AS zh_instructions, i.provenance AS zh_provenance`;
const joined = `FROM catalog_exercises
  LEFT JOIN catalog_exercise_i18n i
    ON i.exercise_id = catalog_exercises.id AND i.locale = 'zh-CN'`;

function translation(row: ExerciseRow): ExerciseTranslation | undefined {
  if (!row.zh_provenance) return undefined;
  return {
    ...(row.zh_name ? { name: row.zh_name } : {}),
    aliases: row.zh_aliases ? (JSON.parse(row.zh_aliases) as string[]) : [],
    ...(row.zh_description ? { description: row.zh_description } : {}),
    ...(row.zh_instructions ? { instructions: row.zh_instructions } : {}),
    provenance: JSON.parse(row.zh_provenance) as ExerciseTranslation['provenance'],
  };
}
function record(row: ExerciseRow): CatalogExercise {
  return {
    id: row.id,
    externalId: row.external_id,
    origin: row.source,
    catalogVersion: row.catalog_version,
    updatedAt: row.updated_at,
    needsRewrite: row.needs_rewrite === 1,
    data: JSON.parse(row.data) as Exercise,
    ...(translation(row) ? { i18n: translation(row) } : {}),
  };
}

export class D1ExerciseCatalog implements ExerciseCatalog {
  constructor(private db: D1Database) {}
  async get(id: string): Promise<CatalogExercise | null> {
    const row = await this.db
      .prepare(`SELECT ${columns} ${joined} WHERE catalog_exercises.id = ?`)
      .bind(id)
      .first<ExerciseRow>();
    return row ? record(row) : null;
  }
  async search(options: CatalogSearchOptions): Promise<CatalogSearchPage> {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const where = [
      `NOT EXISTS (
        SELECT 1 FROM documents
        WHERE owner_id = ? AND kind = 'exercise' AND deleted = 0 AND id = catalog_exercises.id
      )`,
    ];
    const params: unknown[] = [options.ownerId];
    if (options.bodyPart) {
      where.push('catalog_exercises.body_part = ?');
      params.push(options.bodyPart);
    }
    if (options.equipment) {
      where.push('catalog_exercises.equipment = ?');
      params.push(options.equipment);
    }
    if (options.target) {
      where.push('catalog_exercises.target = ?');
      params.push(options.target);
    }
    if (options.movementCategory) {
      where.push('catalog_exercises.movement_category = ?');
      params.push(options.movementCategory);
    }
    const query = options.query?.trim() ?? '';
    if (!query) return this.byName(where, params, options, limit);
    const contains = containsLike(query);
    const prefix = prefixLike(query);
    where.push(`(
      catalog_exercises.search_text LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM catalog_exercise_i18n AS translation
        WHERE translation.exercise_id = catalog_exercises.id
          AND (
            ifnull(translation.name, '') LIKE ? ESCAPE '\\'
            OR ifnull(translation.aliases, '') LIKE ? ESCAPE '\\'
            OR ifnull(translation.description, '') LIKE ? ESCAPE '\\'
            OR ifnull(translation.instructions, '') LIKE ? ESCAPE '\\'
          )
      )
    )`);
    params.push(contains, contains, contains, contains, contains);
    const cursor =
      options.cursor && 'mode' in options.cursor && options.cursor.mode === 'rank'
        ? options.cursor
        : undefined;
    const outer: string[] = [];
    const outerParams: unknown[] = [];
    if (cursor) {
      outer.push(`(
        match_rank > ? OR (match_rank = ? AND name_len > ?)
        OR (match_rank = ? AND name_len = ? AND id > ?)
      )`);
      outerParams.push(
        cursor.rank,
        cursor.rank,
        cursor.nameLen,
        cursor.rank,
        cursor.nameLen,
        cursor.id,
      );
    }
    const sql = `SELECT * FROM (
      SELECT ${columns},
        CASE
          WHEN lower(json_extract(catalog_exercises.data, '$.name')) LIKE ? ESCAPE '\\' THEN 0
          WHEN EXISTS (
            SELECT 1 FROM catalog_exercise_i18n AS translation
            WHERE translation.exercise_id = catalog_exercises.id
              AND (
                ifnull(translation.name, '') LIKE ? ESCAPE '\\'
                OR EXISTS (
                  SELECT 1 FROM json_each(COALESCE(translation.aliases, '[]')) AS alias
                  WHERE alias.value LIKE ? ESCAPE '\\'
                )
              )
          ) THEN 0
          ELSE 1
        END AS match_rank,
        length(json_extract(catalog_exercises.data, '$.name')) AS name_len
      ${joined}
      WHERE ${where.join(' AND ')}
    ) ranked
    ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
    ORDER BY match_rank, name_len, id
    LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(prefix, prefix, prefix, ...params, ...outerParams, limit + 1)
      .all<ExerciseRow>();
    return page(result.results, limit, (row) => ({
      mode: 'rank',
      rank: Number(row.match_rank),
      nameLen: Number(row.name_len),
      id: row.id,
    }));
  }
  private async byName(
    where: string[],
    params: unknown[],
    options: CatalogSearchOptions,
    limit: number,
  ): Promise<CatalogSearchPage> {
    const outer: string[] = [];
    const outerParams: unknown[] = [];
    if (options.cursor && 'mode' in options.cursor && options.cursor.mode === 'name') {
      outer.push('(sort_name > ? OR (sort_name = ? AND id > ?))');
      outerParams.push(options.cursor.name, options.cursor.name, options.cursor.id);
    }
    const sql = `SELECT * FROM (
      SELECT ${columns}, json_extract(catalog_exercises.data, '$.name') AS sort_name
      ${joined}
      WHERE ${where.join(' AND ')}
    ) ranked
    ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
    ORDER BY sort_name COLLATE NOCASE, id
    LIMIT ?`;
    const result = await this.db
      .prepare(sql)
      .bind(...params, ...outerParams, limit + 1)
      .all<ExerciseRow>();
    return page(result.results, limit, (row) => ({
      mode: 'name',
      name: String(row.sort_name),
      id: row.id,
    }));
  }
}

function page(
  rows: ExerciseRow[],
  limit: number,
  cursorFor: (row: ExerciseRow) => NonNullable<CatalogSearchPage['cursor']>,
): CatalogSearchPage {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(record),
    cursor: rows.length > limit && last ? cursorFor(last) : null,
  };
}
