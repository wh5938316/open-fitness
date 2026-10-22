import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATALOG_VERSION = 1;
export const CATALOG_UPDATED_AT = '2026-10-21T00:00:00.000Z';
export const EXERCISEDB_COMMIT = '7455efae41b330c265e7cd4b78dfa848e7ce5ebd';
export const OPENGIM_COMMIT = 'e348fc17c42c7e9a211c5972e573ad3698190ee2';
export const EXERCISEDB_ATTRIBUTION =
  'ExerciseDB names and English instructions (MIT) via hasaneyldrm/exercises-dataset @7455efae41b3. Movement category and muscle-region ids are catalogue structure from openGym; no openGym prose or media is included.';
export const OPENGIM_ATTRIBUTION =
  'Structured fields and muscle-region ids from openGym (AGPL-3.0) @e348fc17. Description and instructions are original rewrites, or blank when needsRewrite is true. No openGym code, translations, or media.';

export const DIAGRAM_REGIONS = [
  'abs',
  'abductors',
  'adductors',
  'biceps',
  'calves',
  'chest',
  'deltoids',
  'forearm',
  'gluteal',
  'hamstring',
  'hip-flexors',
  'lats',
  'lower-back',
  'obliques',
  'quadriceps',
  'serratus',
  'trapezius',
  'triceps',
  'upper-back',
];
const FRONT = new Set([
  'abs',
  'abductors',
  'adductors',
  'biceps',
  'chest',
  'hip-flexors',
  'obliques',
  'quadriceps',
  'serratus',
]);
const BACK = new Set([
  'abductors',
  'gluteal',
  'hamstring',
  'lats',
  'lower-back',
  'trapezius',
  'triceps',
  'upper-back',
]);
const REGION_SET = new Set(DIAGRAM_REGIONS);

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const taxonomy = JSON.parse(readFileSync(join(serverRoot, 'catalog/taxonomy.json'), 'utf8'));

export function loggingCategory(bodyPart) {
  return bodyPart === 'cardio' ? 'duration' : 'strength';
}

export function label(token, locale) {
  if (!token) return '';
  for (const group of ['muscle', 'bodyPart', 'equipment', 'movementCategory']) {
    const entry = taxonomy[group]?.[token];
    if (entry) return entry[locale] ?? entry.en ?? token;
  }
  return token;
}

export function diagramViews(regions, bodyPart) {
  const front = regions.some((id) => FRONT.has(id));
  const back = regions.some((id) => BACK.has(id));
  if (front && !back) return ['front'];
  if (back && !front) return ['back'];
  if (front && back) return ['front', 'back'];
  if (bodyPart === 'chest' || bodyPart === 'waist') return ['front'];
  if (bodyPart === 'back') return ['back'];
  return ['front', 'back'];
}

export function highlightRegions(muscleMap) {
  if (!muscleMap || typeof muscleMap !== 'object') return [];
  const ids = new Set();
  for (const id of muscleMap.primaries ?? []) if (REGION_SET.has(id)) ids.add(id);
  for (const id of muscleMap.secondaries ?? []) if (REGION_SET.has(id)) ids.add(id);
  for (const [id, weight] of Object.entries(muscleMap.weights ?? {})) {
    if (REGION_SET.has(id) && typeof weight === 'number' && weight > 0) ids.add(id);
  }
  return [...ids];
}

export function cleanMuscleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const map = {};
  if (Array.isArray(value.primaries))
    map.primaries = value.primaries.filter((item) => typeof item === 'string');
  if (Array.isArray(value.secondaries))
    map.secondaries = value.secondaries.filter((item) => typeof item === 'string');
  if (value.weights && typeof value.weights === 'object') {
    const weights = {};
    for (const [key, weight] of Object.entries(value.weights)) {
      if (typeof weight === 'number' && Number.isFinite(weight)) weights[key] = weight;
    }
    if (Object.keys(weights).length) map.weights = weights;
  }
  if (typeof value.bodyPart === 'string') map.bodyPart = value.bodyPart;
  return Object.keys(map).length ? map : undefined;
}

export function numberedSteps(steps) {
  return steps.map((step, index) => `${index + 1}. ${step.trim()}`).join('\n');
}

export function cleanName(name) {
  return name.replaceAll('в°', '°').trim();
}

function words(text) {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function grams(text, size) {
  const tokens = words(text);
  const found = new Set();
  for (let index = 0; index <= tokens.length - size; index += 1)
    found.add(tokens.slice(index, index + size).join(' '));
  return found;
}

function jaccard(left, right) {
  const a = new Set(words(left));
  const b = new Set(words(right));
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function acceptableRewrite(original, rewrite) {
  if (!rewrite || typeof rewrite.description !== 'string' || !rewrite.description.trim())
    return false;
  if (!Array.isArray(rewrite.instructions) || !rewrite.instructions.length) return false;
  if (rewrite.instructions.some((step) => typeof step !== 'string' || !step.trim())) return false;
  const fresh = [rewrite.description, ...rewrite.instructions].join(' ');
  const source = [original.description ?? '', ...(original.instructions ?? [])].join(' ');
  if (/https?:\/\/|data:image|\.gif|\.mp4|\.webp|\.png|\.jpe?g/i.test(fresh)) return false;
  for (const gram of grams(source, 5)) if (grams(fresh, 5).has(gram)) return false;
  if (jaccard(original.description ?? '', rewrite.description) >= 0.5) return false;
  if (jaccard((original.instructions ?? []).join(' '), rewrite.instructions.join(' ')) >= 0.55)
    return false;
  return true;
}

export function searchText(exercise, translation) {
  const parts = [
    exercise.name,
    exercise.bodyPart,
    exercise.equipment,
    exercise.target,
    ...(exercise.secondaryMuscles ?? []),
    exercise.movementCategory,
    translation?.name,
    translation?.description,
    translation?.instructions,
    ...(translation?.aliases ?? []),
    label(exercise.bodyPart, 'en'),
    label(exercise.bodyPart, 'zh-CN'),
    label(exercise.equipment, 'en'),
    label(exercise.equipment, 'zh-CN'),
    label(exercise.target, 'en'),
    label(exercise.target, 'zh-CN'),
    label(exercise.movementCategory, 'en'),
    label(exercise.movementCategory, 'zh-CN'),
    ...(exercise.secondaryMuscles ?? []).flatMap((token) => [
      label(token, 'en'),
      label(token, 'zh-CN'),
    ]),
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function loadJsonDir(directory) {
  const merged = {};
  let names = [];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return merged;
  }
  for (const name of names)
    Object.assign(merged, JSON.parse(readFileSync(join(directory, name), 'utf8')));
  return merged;
}

export function genderFor(id, record, femaleIds, maleIds) {
  const female = femaleIds.has(id);
  const male = maleIds.has(id);
  if (female && !male) return 'female';
  if (male && !female) return 'male';
  if (record?.maleVariant && !record?.femaleVariant) return 'female';
  if (record?.femaleVariant && !record?.maleVariant) return 'male';
  return female ? 'female' : 'male';
}

export function toStoredExercise(entry) {
  const catalogId = `cat-${entry.id}`;
  const muscles = [...new Set([entry.target, ...(entry.secondaryMuscles ?? [])].filter(Boolean))];
  const regions = highlightRegions(entry.muscleMap);
  const primaryRegions = (entry.muscleMap?.primaries ?? []).filter((id) => REGION_SET.has(id));
  const data = {
    name: entry.name,
    aliases: [],
    category: entry.category,
    instructions: entry.instructions,
    description: entry.description,
    needsRewrite: entry.needsRewrite,
    muscleGroups: muscles,
    equipment: entry.equipment ? [entry.equipment] : [],
    mediaAssetIds: [],
    notes: '',
    bodyPart: entry.bodyPart,
    primaryMuscles: entry.target ? [entry.target] : [],
    secondaryMuscles: entry.secondaryMuscles ?? [],
    movementCategory: entry.movementCategory,
    externalIds: entry.externalIds,
    source: {
      kind: 'catalog',
      origin: entry.origin,
      catalogId,
      catalogVersion: CATALOG_VERSION,
      ...(entry.origin === 'exercisedb' ? { license: 'MIT' } : {}),
      attribution: entry.origin === 'exercisedb' ? EXERCISEDB_ATTRIBUTION : OPENGIM_ATTRIBUTION,
      needsRewrite: entry.needsRewrite,
    },
    diagram: {
      gender: entry.gender,
      views: diagramViews(primaryRegions.length ? primaryRegions : regions, entry.bodyPart),
      regions,
    },
  };
  if (entry.muscleMap) data.muscleMap = entry.muscleMap;
  if (entry.variantOf) data.variantOf = `cat-${entry.variantOf}`;
  return data;
}
