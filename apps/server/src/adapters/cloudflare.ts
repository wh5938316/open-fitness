import { AppError, conflict } from '../errors';
import { containsLike } from '../domain/search';
import { healthStatements } from './cloudflare-health';
import type {
  CacheStore,
  Commit,
  Entity,
  EntityKind,
  ListOptions,
  ObjectStore,
  Page,
  Repository,
} from '../types';

interface Row {
  id: string;
  kind: EntityKind;
  version: number;
  data: string;
  created_at: string;
  updated_at: string;
  deleted: number;
}
function entity<T>(row: Row): Entity<T> {
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    data: JSON.parse(row.data) as T,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted ? { deleted: true } : {}),
  };
}

export class D1Repository implements Repository {
  constructor(public db: D1Database) {}
  async get<T>(ownerId: string, kind: EntityKind, id: string): Promise<Entity<T> | null> {
    const row = await this.db
      .prepare('SELECT * FROM documents WHERE owner_id=? AND kind=? AND id=? AND deleted=0')
      .bind(ownerId, kind, id)
      .first<Row>();
    return row ? entity<T>(row) : null;
  }
  async getAny<T>(ownerId: string, kind: EntityKind, id: string): Promise<Entity<T> | null> {
    const row = await this.db
      .prepare('SELECT * FROM documents WHERE owner_id=? AND kind=? AND id=?')
      .bind(ownerId, kind, id)
      .first<Row>();
    return row ? entity<T>(row) : null;
  }
  async searchOwnedExercises<T>(
    ownerId: string,
    options: {
      limit: number;
      cursor?: { date: string; id: string };
      query?: string;
      bodyPart?: string;
      equipment?: string;
      target?: string;
      movementCategory?: string;
    },
  ): Promise<{ items: Entity<T>[]; cursor: { date: string; id: string } | null }> {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const where = ['owner_id=?', "kind='exercise'", 'deleted=0'];
    const params: unknown[] = [ownerId];
    const query = options.query?.trim();
    if (query) {
      const pattern = containsLike(query);
      where.push(`(
        LOWER(COALESCE(json_extract(data, '$.name'), '')) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM json_each(documents.data, '$.aliases') AS alias
          WHERE LOWER(alias.value) LIKE ? ESCAPE '\\'
        )
        OR LOWER(COALESCE(json_extract(data, '$.i18n."zh-CN".name'), '')) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM json_each(COALESCE(json_extract(documents.data, '$.i18n."zh-CN".aliases'), '[]')) AS alias
          WHERE LOWER(alias.value) LIKE ? ESCAPE '\\'
        )
      )`);
      params.push(pattern, pattern, pattern, pattern);
    }
    if (options.bodyPart) {
      where.push("json_extract(data, '$.bodyPart') = ?");
      params.push(options.bodyPart);
    }
    if (options.equipment) {
      where.push(`EXISTS (
        SELECT 1 FROM json_each(documents.data, '$.equipment') AS item
        WHERE item.value = ?
      )`);
      params.push(options.equipment);
    }
    if (options.target) {
      where.push(`EXISTS (
        SELECT 1 FROM json_each(documents.data, '$.primaryMuscles') AS item
        WHERE item.value = ?
      )`);
      params.push(options.target);
    }
    if (options.movementCategory) {
      where.push("json_extract(data, '$.movementCategory') = ?");
      params.push(options.movementCategory);
    }
    if (options.cursor) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(options.cursor.date, options.cursor.date, options.cursor.id);
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<Row>();
    const rows = result.results.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => entity<T>(row)),
      cursor: result.results.length > limit && last ? { date: last.created_at, id: last.id } : null,
    };
  }
  async list<T>(
    ownerId: string,
    kind: EntityKind,
    options: ListOptions = {},
  ): Promise<Page<Entity<T>>> {
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const conditions = ['owner_id=?', 'kind=?', 'deleted=0'];
    const values: (string | number)[] = [ownerId, kind];
    if (options.query) {
      const pattern = containsLike(options.query);
      if (kind === 'food') {
        conditions.push(`(
          LOWER(COALESCE(json_extract(data, '$.name'), '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(json_extract(data, '$.barcode'), '')) LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM json_each(documents.data, '$.aliases') AS alias
            WHERE LOWER(alias.value) LIKE ? ESCAPE '\\'
          )
        )`);
        values.push(pattern, pattern, pattern);
      } else {
        conditions.push("LOWER(data) LIKE ? ESCAPE '\\'");
        values.push(pattern);
      }
    }
    if (options.cursor) {
      let cursor: { date: string; id: string };
      try {
        cursor = JSON.parse(atob(options.cursor));
        if (typeof cursor.date !== 'string' || typeof cursor.id !== 'string') throw new Error();
      } catch {
        throw new AppError(422, 'INVALID_CURSOR');
      }
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      values.push(cursor.date, cursor.date, cursor.id);
    }
    const field = options.field === 'startedAt' ? 'startedAt' : 'occurredAt';
    if (options.from) {
      conditions.push(`json_extract(data, '$.${field}') >= ?`);
      values.push(options.from);
    }
    if (options.to) {
      conditions.push(`json_extract(data, '$.${field}') < ?`);
      values.push(options.to);
    }
    if (options.exerciseId) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(documents.data, '$.sets') AS workout_set WHERE json_extract(workout_set.value, '$.exerciseId') = ?)",
      );
      values.push(options.exerciseId);
    }
    const result = await this.db
      .prepare(
        `SELECT * FROM documents WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...values, limit + 1)
      .all<Row>();
    const rows = result.results.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => entity<T>(row)),
      cursor:
        result.results.length > limit && last
          ? btoa(JSON.stringify({ date: last.created_at, id: last.id }))
          : null,
    };
  }
  async revisions(ownerId: string, kind: EntityKind, id: string): Promise<unknown[]> {
    const rows = await this.db
      .prepare(
        'SELECT version, data, deleted, created_at FROM document_revisions WHERE owner_id=? AND kind=? AND id=? ORDER BY version DESC',
      )
      .bind(ownerId, kind, id)
      .all<{ version: number; data: string; deleted: number; created_at: string }>();
    return rows.results.map((row) => ({
      version: row.version,
      data: JSON.parse(row.data),
      deleted: Boolean(row.deleted),
      createdAt: row.created_at,
    }));
  }
  async replay(
    ownerId: string,
    operationId: string,
    requestHash: string,
  ): Promise<{ response: unknown } | null> {
    const row = await this.db
      .prepare('SELECT request_hash,response FROM operations WHERE owner_id=? AND operation_id=?')
      .bind(ownerId, operationId)
      .first<{ request_hash: string; response: string }>();
    if (!row) return null;
    if (row.request_hash !== requestHash)
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'idempotencyConflict');
    return { response: JSON.parse(row.response) };
  }
  async findFoodByBarcode<T>(ownerId: string, barcode: string): Promise<Entity<T> | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM documents
         WHERE owner_id=? AND kind='food' AND deleted=0
           AND json_extract(data, '$.barcode')=?
         LIMIT 1`,
      )
      .bind(ownerId, barcode)
      .first<Row>();
    return row ? entity<T>(row) : null;
  }
  async listFoodBarcodes(ownerId: string): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT json_extract(data, '$.barcode') AS barcode FROM documents
         WHERE owner_id=? AND kind='food' AND deleted=0
           AND json_type(data, '$.barcode')='text'`,
      )
      .bind(ownerId)
      .all<{ barcode: string }>();
    return rows.results.map((row) => row.barcode);
  }
  async exportDocuments(ownerId: string): Promise<Entity[]> {
    const items: Entity[] = [];
    let kind = '';
    let id = '';
    for (;;) {
      const page = await this.db
        .prepare(
          `SELECT * FROM documents
           WHERE owner_id=? AND (kind > ? OR (kind=? AND id > ?))
           ORDER BY kind, id LIMIT 200`,
        )
        .bind(ownerId, kind, kind, id)
        .all<Row>();
      if (page.results.length === 0) break;
      for (const row of page.results) items.push(entity(row));
      const last = page.results[page.results.length - 1];
      if (!last || page.results.length < 200) break;
      kind = last.kind;
      id = last.id;
    }
    return items;
  }
  async commit(input: Commit): Promise<unknown> {
    const replay = await this.replay(input.actor.ownerId, input.operationId, input.requestHash);
    if (replay) return replay.response;
    const now = new Date().toISOString();
    const statements = [
      this.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?,?)')
        .bind(
          input.actor.ownerId,
          input.operationId,
          input.requestHash,
          JSON.stringify(input.response),
          now,
        ),
    ];
    if (input.ownerUpdate)
      statements.push(
        this.db
          .prepare(
            'UPDATE owners SET locale=COALESCE(?,locale),time_zone=COALESCE(?,time_zone) WHERE id=?',
          )
          .bind(
            input.ownerUpdate.locale ?? null,
            input.ownerUpdate.timeZone ?? null,
            input.actor.ownerId,
          ),
      );
    for (const { entity: doc, expectedVersion } of input.mutations) {
      if (expectedVersion === undefined) {
        statements.push(
          this.db
            .prepare(
              'INSERT INTO documents(owner_id,kind,id,version,data,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
            )
            .bind(
              input.actor.ownerId,
              doc.kind,
              doc.id,
              1,
              JSON.stringify(doc.data),
              doc.deleted ? 1 : 0,
              doc.createdAt,
              doc.updatedAt,
            ),
        );
      } else {
        statements.push(
          this.db
            .prepare(
              'UPDATE documents SET version=?,data=?,deleted=?,updated_at=? WHERE owner_id=? AND kind=? AND id=?',
            )
            .bind(
              expectedVersion + 1,
              JSON.stringify(doc.data),
              doc.deleted ? 1 : 0,
              doc.updatedAt,
              input.actor.ownerId,
              doc.kind,
              doc.id,
            ),
        );
      }
    }
    for (const event of input.exports ?? []) {
      statements.push(
        this.db
          .prepare(
            "UPDATE health_exports SET generation=generation+1,status='superseded',lease_token_hash=NULL,lease_expires_at=NULL WHERE owner_id=? AND meal_id=? AND meal_version<? AND status NOT IN ('synced','superseded')",
          )
          .bind(input.actor.ownerId, event.mealId, event.version),
      );
      statements.push(
        this.db
          .prepare(
            'INSERT INTO health_exports(id,owner_id,meal_id,meal_version,action,payload,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(
            crypto.randomUUID(),
            input.actor.ownerId,
            event.mealId,
            event.version,
            event.action,
            JSON.stringify(event.payload),
            now,
          ),
      );
    }
    if (input.healthMutation)
      statements.push(...healthStatements(this.db, input.actor.ownerId, input.healthMutation));
    if (input.uploadTicket) {
      const ticket = input.uploadTicket;
      statements.push(
        this.db
          .prepare(
            'INSERT INTO upload_tickets(token_hash,asset_id,content_type,expires_at,owner_id) VALUES(?,?,?,?,?)',
          )
          .bind(
            ticket.tokenHash,
            ticket.assetId,
            ticket.contentType,
            ticket.expiresAt,
            input.actor.ownerId,
          ),
      );
    }
    for (const mutation of input.mutations)
      if (mutation.entity.kind !== 'asset')
        statements.push(
          this.db
            .prepare(
              'DELETE FROM media_references WHERE owner_id=? AND target_kind=? AND target_id=?',
            )
            .bind(input.actor.ownerId, mutation.entity.kind, mutation.entity.id),
        );
    for (const ref of input.mediaReferences ?? []) {
      statements.push(
        this.db
          .prepare(
            'DELETE FROM media_references WHERE owner_id=? AND target_kind=? AND target_id=? AND slot=?',
          )
          .bind(input.actor.ownerId, ref.targetKind, ref.targetId, ref.slot),
      );
      if (ref.assetId)
        statements.push(
          this.db
            .prepare('INSERT INTO media_references VALUES(?,?,?,?,?)')
            .bind(input.actor.ownerId, ref.assetId, ref.targetKind, ref.targetId, ref.slot),
        );
    }
    statements.push(
      this.db
        .prepare(
          'INSERT INTO audit_events(id,actor_id,operation,target_id,created_at,owner_id) VALUES(?,?,?,?,?,?)',
        )
        .bind(
          crypto.randomUUID(),
          input.actor.id,
          input.operation,
          input.mutations[0]?.entity.id ?? null,
          now,
          input.actor.ownerId,
        ),
    );
    try {
      await this.db.batch(statements);
    } catch (error) {
      const completed = await this.replay(
        input.actor.ownerId,
        input.operationId,
        input.requestHash,
      );
      if (completed) return completed.response;
      const text = String(error);
      if (text.includes('HEALTH_EXPORT_CONFLICT'))
        throw new AppError(409, 'HEALTH_EXPORT_CONFLICT', 'healthLeaseExpired');
      if (text.includes('HEALTH_WRITER_BUSY'))
        throw new AppError(409, 'HEALTH_WRITER_BUSY', 'healthWriterConflict');
      if (text.includes('documents_food_barcode') || text.includes('$.barcode'))
        throw new AppError(409, 'FOOD_BARCODE_EXISTS', 'foodBarcodeExists');
      if (text.includes('VERSION_CONFLICT') || text.includes('UNIQUE constraint')) throw conflict();
      throw error;
    }
    return input.response;
  }
  async healthExports(ownerId: string, limit: number, cursor?: string): Promise<unknown> {
    let pivot: { date: string; id: string } | undefined;
    if (cursor) {
      try {
        pivot = JSON.parse(atob(cursor));
        if (!pivot || typeof pivot.date !== 'string' || typeof pivot.id !== 'string')
          throw new Error();
      } catch {
        throw new AppError(422, 'INVALID_CURSOR');
      }
    }
    const sql =
      'SELECT * FROM health_exports WHERE owner_id=?' +
      (pivot ? ' AND (created_at<? OR (created_at=? AND id<?))' : '') +
      ' ORDER BY created_at DESC,id DESC LIMIT ?';
    const args = pivot
      ? [ownerId, pivot.date, pivot.date, pivot.id, limit + 1]
      : [ownerId, limit + 1];
    const rows = (
      await this.db
        .prepare(sql)
        .bind(...args)
        .all<{ id: string; created_at: string; payload: string; status: string }>()
    ).results;
    const last = rows.slice(0, limit).at(-1);
    return {
      items: rows.slice(0, limit).map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
      cursor:
        rows.length > limit && last
          ? btoa(JSON.stringify({ date: last.created_at, id: last.id }))
          : null,
    };
  }
}

export class R2ObjectStore implements ObjectStore {
  constructor(private bucket: R2Bucket) {}
  async put(key: string, body: ArrayBuffer, contentType: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }
  async get(key: string) {
    const object = await this.bucket.get(key);
    return object
      ? {
          body: object.body,
          contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
          etag: object.httpEtag,
        }
      : null;
  }
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
export class KVCache implements CacheStore {
  constructor(private kv: KVNamespace) {}
  async get<T>(key: string): Promise<T | null> {
    return this.kv.get<T>(key, 'json');
  }
  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
  }
}
