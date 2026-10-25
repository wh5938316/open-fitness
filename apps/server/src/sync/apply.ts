import { canonical, sha256 } from '../crypto';
import type { FitnessService } from '../domain/service';
import { AppError } from '../errors';
import type { Entity, EntityKind } from '../types';
import { isDocumentKind, WRITABLE_KINDS } from './contract';

const SAVE: Partial<Record<EntityKind, string>> = {
  exercise: 'save_exercise',
  food: 'save_food',
  plan: 'save_training_plan',
  recipe: 'save_recipe',
};
const DELETE: Partial<Record<EntityKind, string>> = {
  exercise: 'delete_exercise',
  food: 'delete_food',
  plan: 'delete_training_plan',
  recipe: 'delete_recipe',
};

export type SyncRow = Record<string, unknown>;

export async function applyPendingRow(
  service: FitnessService,
  kind: string,
  id: string,
  row: SyncRow,
  sink: {
    writeCanonical: (entity: Entity, error?: string) => void;
    removeRow: (kind: EntityKind, id: string) => void;
    addConflict: (kind: string, id: string, body: string, code: string) => void;
  },
): Promise<void> {
  if (row.pending !== 1 || !isDocumentKind(kind)) return;
  const body = typeof row.body === 'string' ? row.body : JSON.stringify(row.body ?? null);
  const version = typeof row.version === 'number' ? row.version : 0;
  const deleted = row.deleted === 1;
  const fail = async (code: string) => {
    const current = await service.repository.getAny(service.actor.ownerId, kind, id);
    sink.addConflict(kind, id, body, code);
    if (current) sink.writeCanonical(current, code);
    else sink.removeRow(kind, id);
  };
  if (id.length < 1 || id.length > 128) {
    await fail('INVALID_INPUT');
    return;
  }
  if (!WRITABLE_KINDS.has(kind)) {
    await fail('SYNC_READ_ONLY');
    return;
  }
  if (deleted && version < 1) {
    sink.removeRow(kind, id);
    return;
  }
  let data: unknown = null;
  if (!deleted) {
    try {
      data = JSON.parse(body);
    } catch {
      await fail('INVALID_JSON');
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      await fail('INVALID_INPUT');
      return;
    }
  }
  const operationId = `sync-${(
    await sha256(canonical({ kind, id, version, deleted: deleted ? 1 : 0, body }))
  ).slice(0, 64)}`;
  try {
    const name = deleted ? DELETE[kind] : SAVE[kind];
    if (!name) {
      await fail('SYNC_READ_ONLY');
      return;
    }
    await service.execute(name, {
      operationId,
      id,
      ...(version > 0 ? { expectedVersion: version } : {}),
      ...(deleted ? {} : { data }),
    });
    const saved = await service.repository.getAny(service.actor.ownerId, kind, id);
    if (saved) sink.writeCanonical(saved);
    else sink.removeRow(kind, id);
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof AppError))
      console.error(JSON.stringify({ event: 'sync_apply_failed', kind, code }));
    await fail(code);
  }
}
