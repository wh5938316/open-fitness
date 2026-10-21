import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_VERSION,
  EXERCISEDB_COMMIT,
  OPENGIM_COMMIT,
  searchText,
  sqlString,
} from './catalog-lib.mjs';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const remote = process.argv.includes('--remote');
const local = process.argv.includes('--local');
const dryRun = process.argv.includes('--dry-run');
if ([remote, local, dryRun].filter(Boolean).length !== 1) {
  console.error('Use exactly one of --local, --remote, or --dry-run.');
  process.exit(1);
}

const catalog = JSON.parse(
  readFileSync(join(serverRoot, 'catalog/exercises.normalized.json'), 'utf8'),
);
const translations = JSON.parse(
  readFileSync(join(serverRoot, 'catalog/exercise-i18n.zh-CN.json'), 'utf8'),
);
const statements = [];
statements.push(
  `INSERT INTO catalog_meta(key, value) VALUES ${[
    ['catalog_version', String(CATALOG_VERSION)],
    ['exercisedb_commit', EXERCISEDB_COMMIT],
    ['opengym_commit', OPENGIM_COMMIT],
    ['exercise_count', String(catalog.counts.rows)],
    ['rewritten_count', String(catalog.counts.rewritten)],
    ['pending_count', String(catalog.counts.pending)],
    ['updated_at', catalog.updatedAt],
  ]
    .map(([key, value]) => `(${sqlString(key)}, ${sqlString(value)})`)
    .join(', ')} ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
);

for (const row of catalog.exercises) {
  const translation = translations[row.externalId];
  const text = searchText(
    {
      name: row.data.name,
      bodyPart: row.bodyPart,
      equipment: row.equipment,
      target: row.target,
      secondaryMuscles: row.data.secondaryMuscles,
      movementCategory: row.movementCategory,
    },
    translation,
  );
  statements.push(
    `INSERT INTO catalog_exercises(
      id, external_id, source, catalog_version, data, search_text,
      body_part, equipment, target, movement_category, needs_rewrite, updated_at
    ) VALUES (
      ${sqlString(row.id)}, ${sqlString(row.externalId)}, ${sqlString(row.source)},
      ${row.catalogVersion}, ${sqlString(JSON.stringify(row.data))}, ${sqlString(text)},
      ${row.bodyPart ? sqlString(row.bodyPart) : 'NULL'},
      ${row.equipment ? sqlString(row.equipment) : 'NULL'},
      ${row.target ? sqlString(row.target) : 'NULL'},
      ${row.movementCategory ? sqlString(row.movementCategory) : 'NULL'},
      ${row.needsRewrite ? 1 : 0}, ${sqlString(row.updatedAt)}
    ) ON CONFLICT(id) DO UPDATE SET
      external_id = excluded.external_id,
      source = excluded.source,
      catalog_version = excluded.catalog_version,
      data = excluded.data,
      search_text = excluded.search_text,
      body_part = excluded.body_part,
      equipment = excluded.equipment,
      target = excluded.target,
      movement_category = excluded.movement_category,
      needs_rewrite = excluded.needs_rewrite,
      updated_at = excluded.updated_at;`,
  );
  if (!translation) continue;
  statements.push(
    `INSERT INTO catalog_exercise_i18n(
      exercise_id, locale, name, aliases, instructions, provenance
    ) VALUES (
      ${sqlString(row.id)}, 'zh-CN',
      ${translation.name ? sqlString(translation.name) : 'NULL'},
      ${sqlString(JSON.stringify(translation.aliases ?? []))},
      ${translation.instructions ? sqlString(translation.instructions) : 'NULL'},
      ${sqlString(JSON.stringify(translation.provenance))}
    ) ON CONFLICT(exercise_id, locale) DO UPDATE SET
      name = excluded.name,
      aliases = excluded.aliases,
      instructions = excluded.instructions,
      provenance = excluded.provenance;`,
  );
}

const dir = mkdtempSync(join(tmpdir(), 'of-catalog-seed-'));
const files = [];
let chunk = [];
let bytes = 0;
const flush = () => {
  if (!chunk.length) return;
  const file = join(dir, `chunk-${String(files.length).padStart(3, '0')}.sql`);
  writeFileSync(file, chunk.join('\n'));
  files.push(file);
  chunk = [];
  bytes = 0;
};
for (const statement of statements) {
  if (bytes && bytes + statement.length > 70_000) flush();
  chunk.push(statement);
  bytes += statement.length + 1;
}
flush();
console.log(
  `Prepared ${statements.length} statements in ${files.length} files for ${catalog.counts.rows} exercises.`,
);
if (dryRun) {
  console.log(dir);
  process.exit(0);
}

for (const file of files) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', 'DB', remote ? '--remote' : '--local', `--file=${file}`],
    { cwd: serverRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`Seed failed on ${file}`);
    process.exit(result.status ?? 1);
  }
}
rmSync(dir, { recursive: true, force: true });
console.log(
  remote ? 'Remote exercise catalogue seed finished.' : 'Local exercise catalogue seed finished.',
);
