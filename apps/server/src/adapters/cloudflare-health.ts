import type {
  HealthDevice,
  HealthExport,
  HealthMutation,
  HealthState,
  HealthSyncStore,
} from '../domain/health';

export class D1HealthSyncStore implements HealthSyncStore {
  constructor(private db: D1Database) {}
  device(ownerId: string, deviceId: string): Promise<HealthDevice | null> {
    return this.db
      .prepare('SELECT * FROM health_devices WHERE owner_id=? AND id=?')
      .bind(ownerId, deviceId)
      .first<HealthDevice>();
  }
  async state(ownerId: string): Promise<HealthState> {
    const owner = await this.db
      .prepare('SELECT health_writer_device_id,session_epoch FROM owners WHERE id=?')
      .bind(ownerId)
      .first<{ health_writer_device_id: string | null; session_epoch: number }>();
    const row = await this.db
      .prepare(
        "SELECT SUM(CASE WHEN status IN ('awaiting_device','syncing','failed') THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,MAX(delivered_at) AS delivered,MAX(CASE WHEN status='syncing' THEN lease_expires_at END) AS lease FROM health_exports WHERE owner_id=?",
      )
      .bind(ownerId)
      .first<{ pending: number; failed: number; delivered: string | null; lease: number | null }>();
    return {
      writerDeviceId: owner?.health_writer_device_id ?? null,
      epoch: owner?.session_epoch ?? -1,
      pendingCount: row?.pending ?? 0,
      failedCount: row?.failed ?? 0,
      lastDeliveredAt: row?.delivered ?? null,
      activeLeaseUntil: row?.lease ?? null,
    };
  }
  async pending(ownerId: string, limit: number): Promise<HealthExport[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM health_exports WHERE owner_id=? AND (status IN ('awaiting_device','failed') OR (status='syncing' AND lease_expires_at<=?)) ORDER BY created_at,meal_version,id LIMIT ?",
      )
      .bind(ownerId, Date.now(), limit)
      .all<HealthExport & { payload: string }>();
    return rows.results.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  async event(ownerId: string, eventId: string): Promise<HealthExport | null> {
    const row = await this.db
      .prepare('SELECT * FROM health_exports WHERE owner_id=? AND id=?')
      .bind(ownerId, eventId)
      .first<HealthExport & { payload: string }>();
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }
}

export function healthStatements(
  db: D1Database,
  ownerId: string,
  mutation: HealthMutation,
): D1PreparedStatement[] {
  if (mutation.kind === 'enroll') {
    const d = mutation.device;
    return [
      db
        .prepare('INSERT INTO health_devices VALUES(?,?,?,?,?,?,?,?)')
        .bind(d.id, d.owner_id, d.actor_id, d.name, d.secret_hash, d.epoch, d.status, d.created_at),
      db
        .prepare(
          'UPDATE owners SET health_writer_device_id=COALESCE(health_writer_device_id,?) WHERE id=?',
        )
        .bind(d.id, ownerId),
    ];
  }
  if (mutation.kind === 'writer')
    return [
      db
        .prepare('UPDATE owners SET health_writer_device_id=? WHERE id=?')
        .bind(mutation.deviceId, ownerId),
    ];
  if (mutation.kind === 'claim')
    return mutation.events.map((event) =>
      db
        .prepare(
          "UPDATE health_exports SET generation=?,status='syncing',claimed_device_id=?,lease_token_hash=?,lease_expires_at=?,error_code=NULL WHERE owner_id=? AND id=?",
        )
        .bind(
          event.generation + 1,
          mutation.deviceId,
          mutation.leaseHash,
          mutation.expiresAt,
          ownerId,
          event.id,
        ),
    );
  return [
    db
      .prepare(
        'UPDATE health_exports SET generation=?,status=?,lease_token_hash=NULL,lease_expires_at=NULL,error_code=?,delivered_at=? WHERE owner_id=? AND id=?',
      )
      .bind(
        mutation.generation + 1,
        mutation.status,
        mutation.errorCode,
        mutation.deliveredAt,
        ownerId,
        mutation.eventId,
      ),
  ];
}
