import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { D1Repository, KVCache } from '../src/adapters/cloudflare';
import { D1HealthSyncStore } from '../src/adapters/cloudflare-health';
import { registerHealthOperations } from '../src/domain/health';
import { FitnessService } from '../src/domain/service';

const op = () => crypto.randomUUID();
function phone(id: string, scopes = ['fitness:full', 'health:sync']) {
  const service = new FitnessService(
    new D1Repository(env.DB),
    { ownerId: 'owner', id, kind: 'bot', locale: 'en', timeZone: 'America/New_York', scopes },
    {
      lookup: async () => ({ food: null, stale: false }),
      search: async () => ({ items: [], catalogStatus: 'ok' as const }),
      refresh: async () => {
        throw new Error('catalog refresh is not configured');
      },
    },
  );
  registerHealthOperations(service, new D1HealthSyncStore(env.DB), new KVCache(env.CACHE));
  return service;
}
const food = {
  name: 'Health export fixture',
  basis: { quantity: 100, unit: 'g' },
  nutrients: { energyKcal: 130, proteinG: 3 },
  source: { kind: 'user' },
};

describe('native HealthKit synchronization', () => {
  it('requires the separately approved permission', async () => {
    await expect(
      phone('ordinary-bot', ['fitness:full']).execute('enroll_health_device', {
        operationId: op(),
        name: 'Unauthorized client',
      }),
    ).rejects.toMatchObject({ code: 'HEALTH_PERMISSION_REQUIRED' });
  });
  it('leases exports to one iPhone, handles corrections and deletions, and validates real receipts', async () => {
    const a = phone('phone-a');
    const b = phone('phone-b');
    const first = (await a.execute('enroll_health_device', {
      operationId: op(),
      name: 'First iPhone',
    })) as any;
    const second = (await b.execute('enroll_health_device', {
      operationId: op(),
      name: 'Second iPhone',
    })) as any;
    const created = (await a.execute('log_meal', {
      operationId: op(),
      occurredAt: '2026-10-20T12:00:00Z',
      ingredients: [{ id: 'rice', food, quantity: 100, unit: 'g' }],
    })) as any;
    const claim = { operationId: op(), ...first };
    const lease = (await a.execute('claim_health_exports', claim)) as any;
    expect(await a.execute('claim_health_exports', claim)).toEqual(lease);
    expect(lease.items).toHaveLength(1);
    await expect(
      b.execute('claim_health_exports', { operationId: op(), ...second }),
    ).rejects.toMatchObject({ code: 'HEALTH_WRITER_CONFLICT' });
    await expect(
      b.execute('claim_health_exports', { operationId: op(), ...first }),
    ).rejects.toMatchObject({ code: 'HEALTH_DEVICE_REVOKED' });
    await expect(
      a.execute('acknowledge_health_export', {
        operationId: op(),
        ...first,
        eventId: lease.items[0].id,
        leaseToken: 'invalid-token-with-more-than-32-characters',
        status: 'synced',
      }),
    ).rejects.toMatchObject({ code: 'HEALTH_LEASE_EXPIRED' });
    const receipt = {
      operationId: op(),
      ...first,
      eventId: lease.items[0].id,
      leaseToken: lease.leaseToken,
      status: 'synced',
    };
    expect(await a.execute('acknowledge_health_export', receipt)).toEqual(
      await a.execute('acknowledge_health_export', receipt),
    );
    const revised = (await a.execute('revise_meal', {
      operationId: op(),
      id: created.id,
      expectedVersion: 1,
      overrides: [{ ingredientId: 'rice', quantity: 150 }],
    })) as any;
    const older = (await a.execute('claim_health_exports', { operationId: op(), ...first })) as any;
    const newest = (await a.execute('revise_meal', {
      operationId: op(),
      id: created.id,
      expectedVersion: revised.version,
      overrides: [{ ingredientId: 'rice', quantity: 200 }],
    })) as any;
    await expect(
      a.execute('acknowledge_health_export', {
        operationId: op(),
        ...first,
        eventId: older.items[0].id,
        leaseToken: older.leaseToken,
        status: 'synced',
      }),
    ).rejects.toMatchObject({ code: 'HEALTH_LEASE_EXPIRED' });
    const current = (await a.execute('claim_health_exports', {
      operationId: op(),
      ...first,
    })) as any;
    expect(current.items[0].version).toBe(3);
    await expect(
      b.execute('select_health_writer', { operationId: op(), ...second }),
    ).rejects.toMatchObject({ code: 'HEALTH_WRITER_BUSY' });
    await a.execute('acknowledge_health_export', {
      operationId: op(),
      ...first,
      eventId: current.items[0].id,
      leaseToken: current.leaseToken,
      status: 'failed',
      errorCode: 'HEALTHKIT_PERMISSION_REQUIRED',
    });
    await b.execute('select_health_writer', { operationId: op(), ...second });
    const retry = (await b.execute('claim_health_exports', {
      operationId: op(),
      ...second,
    })) as any;
    await b.execute('acknowledge_health_export', {
      operationId: op(),
      ...second,
      eventId: retry.items[0].id,
      leaseToken: retry.leaseToken,
      status: 'synced',
    });
    await b.execute('delete_meal', {
      operationId: op(),
      id: newest.id,
      expectedVersion: newest.version,
    });
    const deletion = (await b.execute('claim_health_exports', {
      operationId: op(),
      ...second,
    })) as any;
    expect(deletion.items[0].action).toBe('delete');
    await b.execute('acknowledge_health_export', {
      operationId: op(),
      ...second,
      eventId: deletion.items[0].id,
      leaseToken: deletion.leaseToken,
      status: 'synced',
    });
    expect(((await b.execute('get_health_sync_status', {})) as any).pendingCount).toBe(0);
    await env.DB.prepare("UPDATE owners SET session_epoch=session_epoch+1 WHERE id='owner'").run();
    await expect(
      b.execute('claim_health_exports', { operationId: op(), ...second }),
    ).rejects.toMatchObject({ code: 'HEALTH_DEVICE_REVOKED' });
  });
  it('caches consented summaries without adding raw measurements to the business database', async () => {
    const service = phone('summary-phone');
    const device = (await service.execute('enroll_health_device', {
      operationId: op(),
      name: 'Summary iPhone',
    })) as any;
    const operationId = op();
    await service.execute('upload_health_snapshot', {
      operationId,
      ...device,
      snapshot: {
        measuredAt: new Date().toISOString(),
        day: '2026-10-20',
        timeZone: 'America/New_York',
        steps: 0,
      },
    });
    const result = (await service.execute('get_health_snapshot', {})) as any;
    expect(result.snapshot.steps).toBe(0);
    expect(result.snapshot.bodyMassKg).toBeNull();
    expect(result.snapshot.source).toBe('apple_health');
    expect(
      await env.DB.prepare('SELECT operation_id FROM operations WHERE operation_id=?')
        .bind(operationId)
        .first(),
    ).toBeNull();
    await expect(
      service.execute('upload_health_snapshot', {
        operationId: op(),
        ...device,
        snapshot: {
          measuredAt: new Date(Date.now() - 7200000).toISOString(),
          day: '2026-10-20',
          timeZone: 'America/New_York',
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_HEALTH_SNAPSHOT' });
  });
});
