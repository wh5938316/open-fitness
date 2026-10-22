import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEMALE_BACK, FEMALE_FRONT, MALE_BACK, MALE_FRONT } from '@musclemap/assets';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mapping = JSON.parse(
  readFileSync(join(serverRoot, 'catalog/musclemap-regions.json'), 'utf8'),
);
const extras = JSON.parse(
  readFileSync(join(serverRoot, 'catalog/musclemap-extra-paths.json'), 'utf8'),
);
const outDir = join(serverRoot, 'public/musclemap');
mkdirSync(outDir, { recursive: true });

const surfaceRegion = new Map();
for (const [region, entry] of Object.entries(mapping.regions)) {
  for (const surface of entry.surfaces) surfaceRegion.set(surface, region);
}

function escapeAttr(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function surfaceId(muscle, centerX) {
  if (muscle.id) return muscle.id;
  const match = /^M(-?\d+(?:\.\d+)?)/.exec(muscle.d);
  const x = match ? Number(match[1]) : centerX;
  if (muscle.group === 'QUADS') return x < centerX ? 'QUADRICEPS_LEFT' : 'QUADRICEPS_RIGHT';
  return null;
}

function mirrorPath(d) {
  return d.replace(/-?\d+(?:\.\d+)?(?:[ ,]+-?\d+(?:\.\d+)?)?/g, (pair) => {
    const parts = pair.trim().split(/[ ,]+/);
    if (parts.length < 2) return pair;
    const x = (1024 - Number(parts[0])).toFixed(1).replace(/\.0$/, '');
    return `${x} ${parts[1]}`;
  });
}

function extraPaths(fileName) {
  const rows = extras.diagrams[fileName.replace('.svg', '')] ?? [];
  const paths = [];
  for (const row of rows) {
    paths.push(row);
    if (row.mirror && row.id.endsWith('_LEFT')) {
      paths.push({
        ...row,
        id: row.id.replace(/_LEFT$/, '_RIGHT'),
        d: mirrorPath(row.d),
      });
    }
  }
  return paths;
}

function render(diagram, fileName) {
  const outline = diagram.outline
    .map(
      (path) =>
        `    <path data-outline="${escapeAttr(path.id)}" d="${escapeAttr(path.d)}" fill="#e7e2d8"/>`,
    )
    .join('\n');
  const muscles = diagram.muscles
    .map((muscle) => {
      const surface = surfaceId(muscle, diagram.centerX);
      const region = surface ? surfaceRegion.get(surface) : undefined;
      const attrs = [
        surface ? `data-surface="${escapeAttr(surface)}"` : null,
        `data-group="${escapeAttr(muscle.group)}"`,
        region ? `data-region="${escapeAttr(region)}"` : null,
      ]
        .filter(Boolean)
        .join(' ');
      return `    <path ${attrs} d="${escapeAttr(muscle.d)}" fill="#c8b8a4" stroke="#44403c" stroke-width="1"/>`;
    })
    .concat(
      extraPaths(fileName).map((muscle) => {
        const region = surfaceRegion.get(muscle.id);
        const attrs = [
          `data-surface="${escapeAttr(muscle.id)}"`,
          `data-group="${escapeAttr(muscle.group)}"`,
          region ? `data-region="${escapeAttr(region)}"` : null,
          'data-extra="open-fitness"',
        ]
          .filter(Boolean)
          .join(' ');
        return `    <path ${attrs} d="${escapeAttr(muscle.d)}" fill="#c8b8a4" stroke="#44403c" stroke-width="1"/>`;
      }),
    )
    .join('\n');
  const title = fileName.replace('.svg', '').replaceAll('-', ' ');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${escapeAttr(diagram.viewBox)}" data-diagram="${escapeAttr(fileName.replace('.svg', ''))}">
  <title>${escapeAttr(title)} body diagram</title>
  <g id="outline">
${outline}
  </g>
  <g id="muscles">
${muscles}
  </g>
</svg>
`;
  writeFileSync(join(outDir, fileName), svg);
}

render(MALE_FRONT, 'male-front.svg');
render(MALE_BACK, 'male-back.svg');
render(FEMALE_FRONT, 'female-front.svg');
render(FEMALE_BACK, 'female-back.svg');
console.log('wrote four musclemap SVGs');
