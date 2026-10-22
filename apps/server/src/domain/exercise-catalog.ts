import regions from '../../catalog/musclemap-regions.json';
import taxonomy from '../../catalog/taxonomy.json';
import type { Exercise } from './schemas';
import type { Entity, Locale } from '../types';

export const DIAGRAM_REGIONS = taxonomy.diagramRegions;
export const MUSCLEMAP_ARTWORK = 'ready' as const;
export const MUSCLEMAP_FILES = [
  'male-front.svg',
  'male-back.svg',
  'female-front.svg',
  'female-back.svg',
] as const;

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

export interface ExerciseTranslation {
  name?: string;
  aliases?: string[];
  description?: string;
  instructions?: string;
  provenance: { method: 'machine' | 'human'; reviewed: boolean; tool?: string };
}
export interface CatalogExercise {
  id: string;
  externalId: string;
  origin: 'exercisedb' | 'opengym';
  catalogVersion: number;
  updatedAt: string;
  needsRewrite: boolean;
  data: Exercise;
  i18n?: ExerciseTranslation;
}
export interface CatalogSearchOptions {
  ownerId: string;
  limit: number;
  query?: string;
  bodyPart?: string;
  equipment?: string;
  target?: string;
  movementCategory?: string;
  cursor?:
    | { mode: 'name'; name: string; id: string }
    | { mode: 'rank'; rank: number; nameLen: number; id: string };
}
export interface CatalogSearchPage {
  items: CatalogExercise[];
  cursor: CatalogSearchOptions['cursor'] | null;
}
export interface ExerciseCatalog {
  get(id: string): Promise<CatalogExercise | null>;
  search(options: CatalogSearchOptions): Promise<CatalogSearchPage>;
}
export const emptyExerciseCatalog: ExerciseCatalog = {
  async get() {
    return null;
  },
  async search() {
    return { items: [], cursor: null };
  },
};

type Labels = Record<string, { en: string; 'zh-CN': string }>;
const groups = [
  taxonomy.muscle,
  taxonomy.bodyPart,
  taxonomy.equipment,
  taxonomy.movementCategory,
] as Labels[];

export function isCatalogExerciseId(id: string): boolean {
  return /^cat-\d{4,5}$/.test(id);
}
export function canonicalCatalogId(id: string): string | null {
  if (isCatalogExerciseId(id)) return id;
  if (/^\d{4,5}$/.test(id)) return `cat-${id}`;
  return null;
}
export function loggingCategory(bodyPart?: string | null): 'strength' | 'duration' {
  return bodyPart === 'cardio' ? 'duration' : 'strength';
}
export function taxonomyLabel(token: string, locale: Locale): string {
  for (const group of groups) {
    const entry = group[token];
    if (entry) return entry[locale] ?? entry.en;
  }
  return token;
}
export function diagramViews(regions: string[], bodyPart?: string | null): Array<'front' | 'back'> {
  const front = regions.some((id) => FRONT.has(id));
  const back = regions.some((id) => BACK.has(id));
  if (front && !back) return ['front'];
  if (back && !front) return ['back'];
  if (front && back) return ['front', 'back'];
  if (bodyPart === 'chest' || bodyPart === 'waist') return ['front'];
  if (bodyPart === 'back') return ['back'];
  return ['front', 'back'];
}
export function diagramHrefs(gender: 'male' | 'female', views: Array<'front' | 'back'>) {
  return views.map((view) => ({ gender, view, href: `/musclemap/${gender}-${view}.svg` }));
}
export function exerciseTaxonomy(locale: Locale) {
  const list = (group: Labels) =>
    Object.entries(group)
      .map(([id, labels]) => ({ id, label: labels[locale] ?? labels.en }))
      .sort((a, b) => a.label.localeCompare(b.label));
  return {
    bodyParts: list(taxonomy.bodyPart as Labels),
    equipment: list(taxonomy.equipment as Labels),
    muscles: list(taxonomy.muscle as Labels),
    movementCategories: list(taxonomy.movementCategory as Labels),
    diagrams: {
      artwork: MUSCLEMAP_ARTWORK,
      viewBox: regions.viewBox,
      package: regions.package,
      packageVersion: regions.version,
      license: regions.license,
      regions: DIAGRAM_REGIONS,
      mapping: Object.entries(regions.regions).map(([id, entry]) => ({
        region: id,
        groups: entry.groups,
        surfaces: entry.surfaces,
        matched: entry.matched,
        ...('note' in entry && entry.note ? { note: entry.note } : {}),
      })),
      unmatched: Object.entries(regions.regions)
        .filter(([, entry]) => !entry.matched)
        .map(([id]) => id),
      assets: {
        male: { front: '/musclemap/male-front.svg', back: '/musclemap/male-back.svg' },
        female: { front: '/musclemap/female-front.svg', back: '/musclemap/female-back.svg' },
      },
    },
  };
}

export type ExerciseCursor =
  | { phase: 'mine'; date: string; id: string }
  | { phase: 'catalog' }
  | { phase: 'catalog'; mode: 'name'; name: string; id: string }
  | { phase: 'catalog'; mode: 'rank'; rank: number; nameLen: number; id: string };

export function encodeExerciseCursor(value: ExerciseCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodeExerciseCursor(value: string): ExerciseCursor {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ExerciseCursor;
  if (!parsed || (parsed.phase !== 'mine' && parsed.phase !== 'catalog')) throw new Error('cursor');
  if (parsed.phase === 'mine' && (typeof parsed.date !== 'string' || typeof parsed.id !== 'string'))
    throw new Error('cursor');
  if (parsed.phase === 'catalog' && 'mode' in parsed) {
    if (
      parsed.mode === 'name' &&
      (typeof parsed.name !== 'string' || typeof parsed.id !== 'string')
    )
      throw new Error('cursor');
    if (
      parsed.mode === 'rank' &&
      (typeof parsed.rank !== 'number' ||
        typeof parsed.nameLen !== 'number' ||
        typeof parsed.id !== 'string')
    )
      throw new Error('cursor');
  }
  return parsed;
}

export function presentExercise(
  data: Exercise,
  locale: Locale,
  translation?: ExerciseTranslation,
): Exercise {
  const copy = structuredClone(data);
  const zh = translation ?? copy.i18n?.['zh-CN'];
  if (zh) copy.i18n = { ...(copy.i18n ?? {}), 'zh-CN': zh };
  const aliases = new Set(copy.aliases ?? []);
  if (locale === 'zh-CN' && zh?.name) {
    aliases.add(copy.name);
    copy.name = zh.name;
    if (zh.description) copy.description = zh.description;
    if (zh.instructions) copy.instructions = zh.instructions;
  } else if (zh?.name) aliases.add(zh.name);
  for (const alias of zh?.aliases ?? []) aliases.add(alias);
  aliases.delete(copy.name);
  copy.aliases = [...aliases];
  const muscles = [...(copy.primaryMuscles ?? []), ...(copy.secondaryMuscles ?? [])];
  if (muscles.length) {
    const seen = new Set<string>();
    copy.muscleGroups = [];
    for (const token of muscles) {
      const label = taxonomyLabel(token, locale);
      if (seen.has(label)) continue;
      seen.add(label);
      copy.muscleGroups.push(label);
    }
  }
  if (copy.diagram) {
    const derived = diagramHighlights(copy);
    const views =
      derived.usedFallback && derived.highlights.length > 0
        ? diagramViews(
            derived.highlights.map((item) => item.region),
            copy.bodyPart,
          )
        : copy.diagram.views;
    copy.diagram = {
      ...copy.diagram,
      views,
      hrefs: diagramHrefs(copy.diagram.gender, views),
      highlights: derived.highlights,
    };
  }
  return copy;
}

const regionTable = regions.regions;
type RegionId = keyof typeof regionTable;

function regionForMuscleToken(token: string): RegionId | undefined {
  const key = token.trim().toLowerCase();
  const aliases = regions.aliases as Record<string, string>;
  const target = aliases[key] ?? (Object.hasOwn(regionTable, key) ? key : undefined);
  if (!target || !Object.hasOwn(regionTable, target)) return undefined;
  return target as RegionId;
}

function diagramHighlights(data: Exercise) {
  const storedPrimary = data.muscleMap?.primaries ?? [];
  const usedFallback = storedPrimary.length === 0;
  const primary: string[] = [];
  const secondary: string[] = [];
  const seen = new Set<string>();
  const weights: Record<string, number> = usedFallback ? {} : (data.muscleMap?.weights ?? {});
  const add = (region: string | undefined, bucket: string[]) => {
    if (!region || seen.has(region)) return;
    seen.add(region);
    bucket.push(region);
  };
  if (usedFallback) {
    for (const token of data.primaryMuscles ?? []) add(regionForMuscleToken(token), primary);
    for (const token of data.secondaryMuscles ?? []) add(regionForMuscleToken(token), secondary);
  } else {
    for (const region of storedPrimary) add(region, primary);
    for (const region of data.muscleMap?.secondaries ?? []) add(region, secondary);
  }
  const primaryIds = new Set(primary);
  const highlights = [...primary, ...secondary].map((region) => {
    const entry = Object.hasOwn(regionTable, region) ? regionTable[region as RegionId] : undefined;
    const weight = weights[region];
    return {
      region,
      role: primaryIds.has(region) ? ('primary' as const) : ('secondary' as const),
      ...(typeof weight === 'number' ? { weight } : {}),
      groups: entry?.groups ?? [],
      surfaces: entry?.surfaces ?? [],
      matched: Boolean(entry?.matched && entry.surfaces.length),
    };
  });
  return { highlights, usedFallback };
}
export function virtualExercise(record: CatalogExercise, locale: Locale): Entity<Exercise> {
  return {
    id: record.id,
    kind: 'exercise',
    version: 0,
    data: presentExercise(record.data, locale, record.i18n),
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  };
}
