import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_UPDATED_AT,
  CATALOG_VERSION,
  EXERCISEDB_COMMIT,
  OPENGIM_COMMIT,
  acceptableRewrite,
  cleanMuscleMap,
  cleanName,
  genderFor,
  loadJsonDir,
  numberedSteps,
  searchText,
  toStoredExercise,
} from './catalog-lib.mjs';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);
const mitPath = args.mit ?? '/tmp/exercise-src/exercises.json';
const openGymDir = args.opengym ?? '/tmp/openGym/catalogue/exercises';
const rewriteDir = args.rewrites ?? '/tmp/exercise-rewrites';
const overridePath = join(serverRoot, 'catalog/rewrites.json');
const i18nPath = join(serverRoot, 'catalog/exercise-i18n.zh-CN.json');
const outPath = join(serverRoot, 'catalog/exercises.normalized.json');
const fixturePath = join(serverRoot, 'tests/fixtures/catalog-exercises.json');
const fixtureIds = [
  '0001',
  '0002',
  '0004',
  '0007',
  '0009',
  '0015',
  '0017',
  '0025',
  '0026',
  '0032',
  '0043',
  '0501',
  '0652',
  '0662',
  '10003',
  '10534',
  '0136',
  '1197',
  '2476',
  '3094',
  '5266',
];

const mit = JSON.parse(readFileSync(mitPath, 'utf8'));
const mitById = new Map(mit.map((row) => [row.id, row]));
const openGym = new Map();
for (const name of readdirSync(openGymDir)) {
  if (!name.endsWith('.json')) continue;
  const record = JSON.parse(readFileSync(join(openGymDir, name), 'utf8'));
  openGym.set(String(record.id), record);
}
const rewrites = loadJsonDir(rewriteDir);
const overrides = JSON.parse(readFileSync(overridePath, 'utf8'));
Object.assign(rewrites, overrides);
const translations = JSON.parse(readFileSync(i18nPath, 'utf8'));

const femaleIds = new Set();
const maleIds = new Set();
for (const record of openGym.values()) {
  if (record.femaleVariant) femaleIds.add(String(record.femaleVariant));
  if (record.maleVariant) maleIds.add(String(record.maleVariant));
}

const bannedKey =
  /^(gif|gifurl|image|images|video|videos|thumbnail|thumbnails|url|https?|media|media_id|mediaid)$/i;
function assertClean(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClean(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (bannedKey.test(key)) throw new Error(`media key ${path}.${key}`);
      assertClean(item, `${path}.${key}`);
    }
    return;
  }
  if (
    typeof value === 'string' &&
    /https?:\/\/|\.(gif|png|jpe?g|webp|mp4)\b|\/videos\/|\/images\//i.test(value)
  )
    throw new Error(`media value at ${path}`);
}

function fromMit(id, openGymRecord) {
  const source = mitById.get(id);
  if (!source) throw new Error(`missing MIT exercise ${id}`);
  const steps = source.instruction_steps?.en;
  if (!Array.isArray(steps) || !steps.length) throw new Error(`missing MIT steps ${id}`);
  return {
    id,
    origin: 'exercisedb',
    name: cleanName(source.name),
    bodyPart: source.body_part,
    equipment: source.equipment,
    target: source.target,
    secondaryMuscles: source.secondary_muscles ?? [],
    movementCategory: openGymRecord.category ?? null,
    category: source.body_part === 'cardio' ? 'duration' : 'strength',
    instructions: numberedSteps(steps),
    description: null,
    needsRewrite: false,
    muscleMap: cleanMuscleMap(openGymRecord.muscleMap),
    gender: genderFor(id, openGymRecord, femaleIds, maleIds),
    externalIds: { exercisedb: id, opengym: id },
  };
}

function fromRewrite(id, record, rewrite) {
  return {
    id,
    origin: 'opengym',
    name: record.name.trim(),
    bodyPart: record.bodyPart,
    equipment: record.equipment,
    target: record.target,
    secondaryMuscles: record.secondaryMuscles ?? [],
    movementCategory: record.category ?? null,
    category: record.bodyPart === 'cardio' ? 'duration' : 'strength',
    instructions: numberedSteps(rewrite.instructions),
    description: rewrite.description.trim(),
    needsRewrite: false,
    muscleMap: cleanMuscleMap(record.muscleMap),
    gender: genderFor(id, record, femaleIds, maleIds),
    externalIds: { opengym: id },
  };
}

function pending(id, record) {
  return {
    id,
    origin: 'opengym',
    name: record.name.trim(),
    bodyPart: record.bodyPart,
    equipment: record.equipment,
    target: record.target,
    secondaryMuscles: record.secondaryMuscles ?? [],
    movementCategory: record.category ?? null,
    category: record.bodyPart === 'cardio' ? 'duration' : 'strength',
    instructions: '',
    description: null,
    needsRewrite: true,
    muscleMap: cleanMuscleMap(record.muscleMap),
    gender: genderFor(id, record, femaleIds, maleIds),
    externalIds: { opengym: id },
  };
}

const built = new Map();
let rewritten = 0;
let rejected = 0;
let pendingCount = 0;
for (const [id, record] of openGym) {
  if (!record.name) continue;
  if (record.textSource === 'exercisedb') {
    built.set(id, fromMit(id, record));
    continue;
  }
  const candidate = rewrites[id];
  if (candidate && acceptableRewrite(record, candidate)) {
    built.set(id, fromRewrite(id, record, candidate));
    rewritten += 1;
  } else {
    if (candidate) rejected += 1;
    built.set(id, pending(id, record));
    pendingCount += 1;
  }
}

let variantCount = 0;
for (const [id, record] of openGym) {
  if (record.name || !record.variantOf) continue;
  const base = built.get(String(record.variantOf));
  if (!base) throw new Error(`variant ${id} is missing base ${record.variantOf}`);
  built.set(id, {
    ...base,
    id,
    gender: genderFor(id, record, femaleIds, maleIds),
    variantOf: String(record.variantOf),
    externalIds:
      base.origin === 'exercisedb' ? { exercisedb: base.id, opengym: id } : { opengym: id },
  });
  variantCount += 1;
  if (base.needsRewrite) pendingCount += 1;
  else if (base.origin === 'opengym') rewritten += 1;
}

const exercises = [...built.values()].sort((a, b) => a.id.localeCompare(b.id));
if (exercises.length !== openGym.size) {
  throw new Error(`expected ${openGym.size} rows, built ${exercises.length}`);
}

const stored = exercises.map((entry) => {
  const data = toStoredExercise(entry);
  assertClean(data, entry.id);
  return {
    id: `cat-${entry.id}`,
    externalId: entry.id,
    source: entry.origin,
    catalogVersion: CATALOG_VERSION,
    needsRewrite: entry.needsRewrite,
    bodyPart: entry.bodyPart,
    equipment: entry.equipment,
    target: entry.target,
    movementCategory: entry.movementCategory,
    updatedAt: CATALOG_UPDATED_AT,
    data,
  };
});

const counts = {
  rows: stored.length,
  exercisedb: stored.filter((row) => row.source === 'exercisedb').length,
  opengym: stored.filter((row) => row.source === 'opengym').length,
  variants: variantCount,
  rewritten,
  pending: stored.filter((row) => row.needsRewrite).length,
  rejectedRewrites: rejected,
};
if (counts.exercisedb + counts.opengym !== counts.rows)
  throw new Error('source counts do not add up');
if (counts.pending + counts.rewritten !== counts.opengym)
  throw new Error(
    `rewrite accounting failed: pending ${counts.pending} rewritten ${counts.rewritten}`,
  );

const document = {
  catalogVersion: CATALOG_VERSION,
  updatedAt: CATALOG_UPDATED_AT,
  sources: {
    exercisedb: {
      repository: 'hasaneyldrm/exercises-dataset',
      commit: EXERCISEDB_COMMIT,
      license: 'MIT',
    },
    opengym: {
      repository: 'DuarteSantos8/openGym',
      commit: OPENGIM_COMMIT,
      license: 'AGPL-3.0',
      usage: 'Structured fields and muscleMap region ids only. Prose is rewritten or omitted.',
    },
  },
  counts,
  exercises: stored,
};
writeFileSync(outPath, JSON.stringify(document));

const fixtureRows = stored.filter((row) => fixtureIds.includes(row.externalId));
const missingFixture = fixtureIds.filter((id) => !fixtureRows.some((row) => row.externalId === id));
if (missingFixture.length) throw new Error(`fixture ids missing: ${missingFixture.join(', ')}`);
const fixture = {
  exercises: fixtureRows.map((row) => ({
    ...row,
    searchText: searchText(
      {
        name: row.data.name,
        bodyPart: row.bodyPart,
        equipment: row.equipment,
        target: row.target,
        secondaryMuscles: row.data.secondaryMuscles,
        movementCategory: row.movementCategory,
      },
      translations[row.externalId],
    ),
  })),
  i18n: fixtureIds
    .filter((id) => translations[id])
    .map((id) => ({
      exerciseId: `cat-${id}`,
      locale: 'zh-CN',
      name: translations[id].name ?? null,
      aliases: translations[id].aliases ?? [],
      instructions: translations[id].instructions ?? null,
      provenance: translations[id].provenance,
    })),
};
writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(JSON.stringify(counts));
