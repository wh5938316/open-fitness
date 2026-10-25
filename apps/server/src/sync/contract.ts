import type { Entity, EntityKind } from '../types';

/** TinyBase owns merging. This publisher only projects committed domain rows into that store. */
export interface SyncPublisher {
  publish(entities: readonly Entity<unknown>[]): Promise<void>;
}

export const DOCUMENT_KINDS = [
  'exercise',
  'plan',
  'workout',
  'food',
  'recipe',
  'meal',
  'asset',
] as const satisfies readonly EntityKind[];

/** Kinds whose save and delete operations can accept a synced document body. */
export const WRITABLE_KINDS = new Set<EntityKind>(['exercise', 'food', 'plan', 'recipe']);

export function isDocumentKind(value: string): value is EntityKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}
