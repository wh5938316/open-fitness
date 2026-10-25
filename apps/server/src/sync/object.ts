import { createMergeableStore, type MergeableStore } from 'tinybase';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { D1Repository } from '../adapters/cloudflare';
import { AuthService, FULL_SCOPE, HEALTH_SCOPE } from '../auth';
import { AppError } from '../errors';
import { resolveLocale } from '../i18n';
import { createOwnerServices } from '../services';
import type { Actor, Entity, EntityKind, Env } from '../types';
import { applyPendingRow, type SyncRow } from './apply';
import { isDocumentKind } from './contract';

const FRAGMENT_BYTES = 32 * 1024;
const stores = new WeakMap<FitnessSyncDurableObject, MergeableStore>();

export class FitnessSyncDurableObject extends WsServerDurableObject<Env> {
  private chain: Promise<void> = Promise.resolve();
  private ownerId: string | undefined;
  private writing = false;
  private draining = false;
  private scheduled = false;
  private fitness: ReturnType<typeof createOwnerServices>['service'] | undefined;

  private get store(): MergeableStore {
    const store = stores.get(this);
    if (!store) throw new Error('SYNC_STORE_MISSING');
    return store;
  }

  override createPersister() {
    const store = createMergeableStore();
    stores.set(this, store);
    store.addRowListener(null, null, (_store, tableId, rowId) => {
      if (this.writing || !this.ownerId || !isDocumentKind(tableId)) return;
      if (store.getRow(tableId, rowId).pending === 1) this.scheduleDrain();
    });
    return createDurableObjectSqlStoragePersister(store, this.ctx.storage.sql, {
      mode: 'fragmented',
      storagePrefix: 'fitness_',
    });
  }

  override getRequestTimeoutSeconds(): number {
    return 10;
  }

  override getFragmentSize(): number {
    return FRAGMENT_BYTES;
  }

  override onIgnoredError(error: unknown): void {
    console.error(
      JSON.stringify({ event: 'sync_message_ignored', message: String(error).slice(0, 200) }),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    this.bindOwner(new URL(request.url).pathname.replace(/^\//, ''));
    await this.hydrate();
    this.scheduleDrain();
    await this.chain;
    return serverFetch(this, request);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    serverMessage(this, ws, message);
    this.ctx.waitUntil(this.chain);
  }

  async publish(ownerId: string, entities: readonly Entity<unknown>[]): Promise<void> {
    this.bindOwner(ownerId);
    await this.hydrate();
    for (const entity of entities) this.importPublished(entity);
    this.scheduleDrain();
    await this.chain;
  }

  private bindOwner(ownerId: string) {
    if (!ownerId) throw new Error('SYNC_OWNER_REQUIRED');
    if (this.ownerId && this.ownerId !== ownerId) throw new Error('SYNC_ROOM_MISMATCH');
    this.ownerId = ownerId;
  }

  private async hydrate(): Promise<void> {
    const ownerId = this.ownerId;
    if (!ownerId) return;
    const documents = await new D1Repository(this.env.DB).exportDocuments(ownerId);
    this.writing = true;
    try {
      this.store.transaction(() => {
        for (const entity of documents) {
          if (!isDocumentKind(entity.kind)) continue;
          const row = this.store.getRow(entity.kind, entity.id);
          const body = JSON.stringify(entity.data);
          if (row.pending === 1) continue;
          if (
            row.version === entity.version &&
            row.deleted === (entity.deleted ? 1 : 0) &&
            row.body === body
          )
            continue;
          this.store.setRow(entity.kind, entity.id, canonicalCells(entity));
        }
      });
    } finally {
      this.writing = false;
    }
  }

  private importPublished(entity: Entity<unknown>) {
    if (!isDocumentKind(entity.kind)) return;
    const row = this.store.getRow(entity.kind, entity.id);
    const body = JSON.stringify(entity.data);
    if (row.pending === 1 && row.body !== body)
      this.addConflict(entity.kind, entity.id, String(row.body ?? ''), 'VERSION_CONFLICT');
    this.writeCanonical(entity);
  }

  private scheduleDrain() {
    if (!this.ownerId || this.scheduled || this.draining) return;
    this.scheduled = true;
    this.chain = this.chain
      .catch(() => undefined)
      .then(async () => {
        this.scheduled = false;
        await this.drain();
      });
  }

  private async drain(): Promise<void> {
    const ownerId = this.ownerId;
    if (!ownerId) return;
    this.draining = true;
    let exhausted = false;
    try {
      const service = await this.fitnessService();
      for (let guard = 0; guard < 20; guard++) {
        const pending = this.pendingRows();
        if (pending.length === 0) return;
        for (const item of pending)
          await applyPendingRow(service, item.kind, item.id, item.row, this.sink());
      }
      exhausted = true;
      console.error(JSON.stringify({ event: 'sync_apply_stopped', ownerId }));
    } finally {
      this.draining = false;
      if (!exhausted && this.pendingRows().length > 0) this.scheduleDrain();
    }
  }

  private pendingRows(): { kind: EntityKind; id: string; row: SyncRow }[] {
    const found: { kind: EntityKind; id: string; row: SyncRow }[] = [];
    for (const kind of this.store.getTableIds()) {
      if (!isDocumentKind(kind)) continue;
      for (const id of this.store.getRowIds(kind)) {
        const row = this.store.getRow(kind, id);
        if (row.pending === 1) found.push({ kind, id, row });
      }
    }
    return found;
  }

  private sink() {
    return {
      writeCanonical: (entity: Entity<unknown>, error = '') => this.writeCanonical(entity, error),
      removeRow: (kind: EntityKind, id: string) => this.removeRow(kind, id),
      addConflict: (kind: string, id: string, body: string, code: string) =>
        this.addConflict(kind, id, body, code),
    };
  }

  private writeCanonical(entity: Entity<unknown>, error = '') {
    if (!isDocumentKind(entity.kind)) return;
    this.writing = true;
    try {
      this.store.setRow(entity.kind, entity.id, canonicalCells(entity, error));
    } finally {
      this.writing = false;
    }
  }

  private removeRow(kind: EntityKind, id: string) {
    this.writing = true;
    try {
      this.store.delRow(kind, id);
    } finally {
      this.writing = false;
    }
  }

  private addConflict(kind: string, id: string, body: string, code: string) {
    this.writing = true;
    try {
      this.store.setRow('conflicts', crypto.randomUUID(), {
        kind,
        recordId: id,
        body,
        code,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      this.writing = false;
    }
  }

  private async fitnessService() {
    if (this.fitness) return this.fitness;
    const ownerId = this.ownerId;
    if (!ownerId) throw new Error('SYNC_OWNER_REQUIRED');
    const auth = new AuthService(this.env);
    const owner = await auth.owner(ownerId);
    if (owner.status !== 'active') throw new AppError(403, 'OWNER_DISABLED', 'forbidden');
    const actor: Actor = {
      ownerId,
      id: 'local-sync',
      kind: 'owner',
      locale: resolveLocale(owner.locale),
      timeZone: owner.time_zone,
      scopes: [FULL_SCOPE, HEALTH_SCOPE],
    };
    this.fitness = createOwnerServices(this.env, actor, auth.origin, {
      publish: async (entities) => {
        for (const entity of entities) this.writeCanonical(entity);
      },
    }).service;
    return this.fitness;
  }
}

type SyncServer = {
  fetch(request: Request): Response | Promise<Response>;
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void;
};

function serverFetch(object: FitnessSyncDurableObject, request: Request) {
  return (WsServerDurableObject.prototype as unknown as SyncServer).fetch.call(object, request);
}

function serverMessage(
  object: FitnessSyncDurableObject,
  ws: WebSocket,
  message: string | ArrayBuffer,
) {
  (WsServerDurableObject.prototype as unknown as SyncServer).webSocketMessage.call(
    object,
    ws,
    message,
  );
}

function canonicalCells(entity: Entity<unknown>, error = '') {
  return {
    version: entity.version,
    deleted: entity.deleted ? 1 : 0,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    body: JSON.stringify(entity.data),
    pending: 0,
    error,
  };
}
