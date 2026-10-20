import { z } from 'zod';
import { randomToken, secretMatches, sha256 } from '../crypto';
import { AppError } from '../errors';
import type { CacheStore } from '../types';
import { id, isoDateTime, operationId, quantity } from './schemas';
import type { FitnessService, Prepared } from './service';

export interface HealthDevice {
  id: string;
  owner_id: string;
  actor_id: string;
  name: string;
  secret_hash: string;
  epoch: number;
  status: string;
  created_at: string;
}
export interface HealthExport {
  id: string;
  meal_id: string;
  meal_version: number;
  action: 'upsert' | 'delete';
  payload: unknown;
  status: string;
  generation: number;
  claimed_device_id: string | null;
  lease_token_hash: string | null;
  lease_expires_at: number | null;
}
export interface HealthState {
  writerDeviceId: string | null;
  pendingCount: number;
  failedCount: number;
  lastDeliveredAt: string | null;
  activeLeaseUntil: number | null;
  epoch: number;
}
export interface HealthSyncStore {
  device(ownerId: string, deviceId: string): Promise<HealthDevice | null>;
  state(ownerId: string): Promise<HealthState>;
  pending(ownerId: string, limit: number): Promise<HealthExport[]>;
  event(ownerId: string, eventId: string): Promise<HealthExport | null>;
}
export type HealthMutation =
  | { kind: 'enroll'; device: HealthDevice }
  | { kind: 'writer'; deviceId: string }
  | {
      kind: 'claim';
      deviceId: string;
      leaseHash: string;
      expiresAt: number;
      events: { id: string; generation: number }[];
    }
  | {
      kind: 'receipt';
      eventId: string;
      generation: number;
      status: 'synced' | 'failed';
      errorCode: string | null;
      deliveredAt: string | null;
    };

export function registerHealthOperations(
  service: FitnessService,
  store: HealthSyncStore,
  cache: CacheStore,
): void {
  const proof = { deviceId: id, deviceSecret: z.string().min(32).max(200) };
  const requireScope = () => {
    if (service.actor.kind !== 'owner' && !service.actor.scopes?.includes('health:sync'))
      throw new AppError(403, 'HEALTH_PERMISSION_REQUIRED', 'healthPermissionRequired');
  };
  const device = async (args: { deviceId: string; deviceSecret: string }) => {
    requireScope();
    const [record, state] = await Promise.all([
      store.device(service.actor.ownerId, args.deviceId),
      store.state(service.actor.ownerId),
    ]);
    if (
      !record ||
      record.status !== 'active' ||
      record.actor_id !== service.actor.id ||
      record.epoch !== state.epoch ||
      !(await secretMatches(await sha256(args.deviceSecret), record.secret_hash))
    )
      throw new AppError(403, 'HEALTH_DEVICE_REVOKED', 'healthDeviceRevoked');
    return record;
  };
  const prepared = (response: unknown, healthMutation: HealthMutation): Prepared => ({
    response,
    mutations: [],
    healthMutation,
  });
  service.add({
    name: 'get_health_sync_status',
    description: 'Read the selected iPhone writer and actual Apple Health delivery status.',
    schema: z.object({}),
    readOnly: true,
    method: 'GET',
    path: '/health/status',
    run: async () => ({ protocolVersion: 1, ...(await store.state(service.actor.ownerId)) }),
  });
  service.add({
    name: 'enroll_health_device',
    description:
      'Enroll an iPhone for HealthKit export. Requires separately approved health:sync permission. Keep the returned device secret in Keychain.',
    schema: z.object({ operationId, name: z.string().min(1).max(200) }),
    readOnly: false,
    method: 'POST',
    path: '/health/devices',
    run: async (args) => {
      requireScope();
      const state = await store.state(service.actor.ownerId);
      const secret = randomToken();
      const record: HealthDevice = {
        id: crypto.randomUUID(),
        owner_id: service.actor.ownerId,
        actor_id: service.actor.id,
        name: args.name,
        secret_hash: await sha256(secret),
        epoch: state.epoch,
        status: 'active',
        created_at: new Date().toISOString(),
      };
      return prepared(
        { deviceId: record.id, deviceSecret: secret },
        { kind: 'enroll', device: record },
      );
    },
  });
  service.add({
    name: 'select_health_writer',
    description:
      'Choose this enrolled iPhone as the only nutrition writer. An active export lease prevents switching.',
    schema: z.object({ operationId, ...proof }),
    readOnly: false,
    method: 'PUT',
    path: '/health/writer',
    run: async (args) => {
      await device(args);
      const state = await store.state(service.actor.ownerId);
      if (state.writerDeviceId !== args.deviceId && (state.activeLeaseUntil ?? 0) > Date.now())
        throw new AppError(409, 'HEALTH_WRITER_BUSY', 'healthWriterConflict');
      return prepared(
        { writerDeviceId: args.deviceId },
        { kind: 'writer', deviceId: args.deviceId },
      );
    },
  });
  service.add({
    name: 'claim_health_exports',
    description:
      'Lease pending nutrition events for two minutes. Only the selected enrolled iPhone may claim. Never acknowledge before HealthKit succeeds.',
    schema: z.object({ operationId, ...proof, limit: z.number().int().min(1).max(20).default(10) }),
    readOnly: false,
    method: 'POST',
    path: '/health/exports/claim',
    run: async (args) => {
      await device(args);
      const state = await store.state(service.actor.ownerId);
      if (state.writerDeviceId !== args.deviceId)
        throw new AppError(409, 'HEALTH_WRITER_CONFLICT', 'healthWriterConflict');
      const events = await store.pending(service.actor.ownerId, args.limit);
      const leaseToken = randomToken();
      const expiresAt = Date.now() + 120000;
      return prepared(
        {
          leaseToken,
          expiresAt: new Date(expiresAt).toISOString(),
          items: events.map((event) => ({
            id: event.id,
            mealId: event.meal_id,
            version: event.meal_version,
            action: event.action,
            payload: event.payload,
          })),
        },
        {
          kind: 'claim',
          deviceId: args.deviceId,
          leaseHash: await sha256(leaseToken),
          expiresAt,
          events: events.map((event) => ({ id: event.id, generation: event.generation })),
        },
      );
    },
  });
  service.add({
    name: 'acknowledge_health_export',
    description:
      'Report a real HealthKit write or deletion result for an unexpired export lease. A superseded event cannot be acknowledged.',
    schema: z.object({
      operationId,
      ...proof,
      eventId: id,
      leaseToken: z.string().min(32).max(200),
      status: z.enum(['synced', 'failed']),
      errorCode: z
        .string()
        .regex(/^[A-Z0-9_]{1,100}$/)
        .optional(),
    }),
    readOnly: false,
    method: 'POST',
    path: '/health/exports/:eventId/receipt',
    run: async (args) => {
      await device(args);
      const event = await store.event(service.actor.ownerId, args.eventId);
      if (
        !event ||
        event.status !== 'syncing' ||
        event.claimed_device_id !== args.deviceId ||
        !event.lease_token_hash ||
        (event.lease_expires_at ?? 0) <= Date.now() ||
        !(await secretMatches(await sha256(args.leaseToken), event.lease_token_hash))
      )
        throw new AppError(409, 'HEALTH_LEASE_EXPIRED', 'healthLeaseExpired');
      return prepared(
        { eventId: event.id, status: args.status },
        {
          kind: 'receipt',
          eventId: event.id,
          generation: event.generation,
          status: args.status,
          errorCode: args.status === 'failed' ? (args.errorCode ?? 'HEALTHKIT_WRITE_FAILED') : null,
          deliveredAt: args.status === 'synced' ? new Date().toISOString() : null,
        },
      );
    },
  });
  const snapshot = z.object({
    measuredAt: isoDateTime,
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timeZone: z.string().max(100),
    steps: quantity.nullable().default(null),
    activeEnergyKcal: quantity.nullable().default(null),
    exerciseMinutes: quantity.nullable().default(null),
    bodyMassKg: quantity.nullable().default(null),
    bodyMassMeasuredAt: isoDateTime.nullable().default(null),
    restingHeartRateBpm: quantity.nullable().default(null),
  });
  service.add({
    name: 'get_health_snapshot',
    description:
      'Read the last consented Apple Health summary. This short-lived cache expires after one hour; missing metrics remain null.',
    schema: z.object({}),
    readOnly: true,
    method: 'GET',
    path: '/health/snapshot',
    run: async () => {
      const value = await cache.get<{ expiresAt: string }>(
        'health:' + service.actor.ownerId + ':snapshot',
      );
      return { snapshot: value && Date.parse(value.expiresAt) > Date.now() ? value : null };
    },
  });
  service.add({
    name: 'upload_health_snapshot',
    description:
      'Cache an explicitly consented native HealthKit summary for one hour. Raw health measurements are not written to the business database.',
    schema: z.object({ operationId, ...proof, snapshot }),
    readOnly: false,
    method: 'PUT',
    path: '/health/snapshot',
    run: async (args) => {
      await device(args);
      const measuredAt = Date.parse(args.snapshot.measuredAt);
      if (measuredAt < Date.now() - 900000 || measuredAt > Date.now() + 120000)
        throw new AppError(422, 'STALE_HEALTH_SNAPSHOT');
      const key = 'health:' + service.actor.ownerId + ':snapshot';
      const previous = await cache.get<{ measuredAt: string }>(key);
      if (!previous || Date.parse(previous.measuredAt) <= measuredAt)
        await cache.put(
          key,
          {
            ...args.snapshot,
            source: 'apple_health',
            expiresAt: new Date(measuredAt + 3600000).toISOString(),
          },
          3600,
        );
      return { cached: true, expiresAt: new Date(measuredAt + 3600000).toISOString() };
    },
  });
}
