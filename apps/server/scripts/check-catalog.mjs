import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(
  readFileSync(join(serverRoot, 'catalog/exercises.normalized.json'), 'utf8'),
);
const mediaKey =
  /^(gif|gifurl|image|images|video|videos|thumbnail|thumbnails|url|https?|media|media_id|mediaid)$/i;
const mediaValue = /https?:\/\/|\.(gif|png|jpe?g|webp|mp4)\b|\/videos\/|\/images\//i;

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
    throw new Error(message);
  }
}

function walk(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert(!mediaKey.test(key), `media key ${path}.${key}`);
      walk(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') assert(!mediaValue.test(value), `media value at ${path}`);
}

assert(
  catalog.exercises.length === 6554,
  `expected 6554 exercises, found ${catalog.exercises.length}`,
);
assert(catalog.counts.rows === catalog.exercises.length, 'header row count drifted');
const exercisedb = catalog.exercises.filter((row) => row.source === 'exercisedb');
const opengym = catalog.exercises.filter((row) => row.source === 'opengym');
assert(exercisedb.length === catalog.counts.exercisedb, 'exercisedb count drifted');
assert(opengym.length === catalog.counts.opengym, 'opengym count drifted');
assert(exercisedb.length + opengym.length === 6554, 'sources do not cover every row');
let rewritten = 0;
let pending = 0;
for (const row of catalog.exercises) {
  walk(row.data, row.id);
  assert(row.data.mediaAssetIds.length === 0, `${row.id} has media assets`);
  assert(row.data.source.origin === row.source, `${row.id} origin drifted`);
  assert(row.data.source.kind === 'catalog', `${row.id} is not a catalogue record`);
  if (row.needsRewrite) {
    pending += 1;
    assert(row.data.description === null, `${row.id} pending row kept a description`);
    assert(row.data.instructions === '', `${row.id} pending row kept instructions`);
    assert(row.source === 'opengym', `${row.id} exercisedb row is pending rewrite`);
  } else if (row.source === 'opengym') {
    rewritten += 1;
    assert(
      typeof row.data.description === 'string' && row.data.description.trim(),
      `${row.id} rewrite is empty`,
    );
    assert(row.data.instructions.trim(), `${row.id} rewrite has no instructions`);
  } else {
    assert(row.data.description === null, `${row.id} exercisedb row stored a description`);
    assert(
      row.data.instructions.includes('\n') || row.data.instructions.startsWith('1. '),
      `${row.id} missing steps`,
    );
  }
  assert(
    row.data.diagram?.gender === 'male' || row.data.diagram?.gender === 'female',
    'diagram gender',
  );
  assert(row.data.diagram.views.length >= 1, 'diagram views');
}
assert(pending === catalog.counts.pending, 'pending count drifted');
assert(rewritten === catalog.counts.rewritten, 'rewritten count drifted');

const musclemap = join(serverRoot, 'public/musclemap');
const requiredSvgs = ['male-front.svg', 'male-back.svg', 'female-front.svg', 'female-back.svg'];
for (const name of requiredSvgs) {
  const file = join(musclemap, name);
  const svg = readFileSync(file, 'utf8');
  assert(svg.includes('viewBox="0 0 1024 1536"'), `${name} is missing the MuscleMap viewBox`);
  assert(svg.includes('data-surface='), `${name} is missing surface ids`);
  assert(!/webp|body-paths/i.test(svg), `${name} includes photo or openGym geometry`);
}
for (const name of readdirSync(musclemap)) {
  const file = join(musclemap, name);
  assert(statSync(file).isFile(), 'unexpected musclemap entry');
  assert(!/\.webp$/i.test(name), 'photo body was committed');
}
const catalogDir = join(serverRoot, 'catalog');
for (const name of readdirSync(catalogDir)) {
  assert(!/\.(gif|png|jpe?g|webp|mp4)$/i.test(name), `binary file in catalog/: ${name}`);
}
console.log(
  `catalog ok: ${catalog.counts.rows} rows, exercisedb ${catalog.counts.exercisedb}, opengym ${catalog.counts.opengym}, rewritten ${rewritten}, pending ${pending}`,
);
