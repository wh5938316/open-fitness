import { createMergeableStore, type MergeableStore } from 'tinybase';
import { createLocalSynchronizer } from 'tinybase/synchronizers/synchronizer-local';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import type { EntityKind } from '../types';

const FRAGMENT_BYTES = 32 * 1024;

export function createFitnessStore(): MergeableStore {
  return createMergeableStore();
}

/** Stage a local edit. TinyBase replicates the row; the server applies writable kinds. */
export function stageSyncChange(
  store: MergeableStore,
  kind: EntityKind,
  id: string,
  data: unknown,
  expectedVersion?: number,
): void {
  const current = store.getRow(kind, id);
  store.setRow(kind, id, {
    version: expectedVersion ?? 0,
    deleted: 0,
    createdAt: typeof current.createdAt === 'string' ? current.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    body: JSON.stringify(data),
    pending: 1,
    error: '',
  });
}

export function stageSyncDelete(
  store: MergeableStore,
  kind: EntityKind,
  id: string,
  expectedVersion: number,
): void {
  const current = store.getRow(kind, id);
  store.setRow(kind, id, {
    version: expectedVersion,
    deleted: 1,
    createdAt: typeof current.createdAt === 'string' ? current.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    body: typeof current.body === 'string' ? current.body : '{}',
    pending: 1,
    error: '',
  });
}

/** In-process TinyBase synchronizer. Two stores in one isolate merge through the library. */
export function createLocalFitnessSynchronizer(store: MergeableStore) {
  return createLocalSynchronizer(store);
}

export async function startFitnessSync(webSocket: WebSocket): Promise<{
  store: MergeableStore;
  stop: () => Promise<void>;
}> {
  const socket = webSocket as WebSocket & { accept?: () => void };
  try {
    socket.accept?.();
  } catch {
    // The runtime may already have accepted the socket.
  }
  const store = createFitnessStore();
  const synchronizer = await createWsSynchronizer(
    store,
    webSocket,
    10,
    undefined,
    undefined,
    undefined,
    FRAGMENT_BYTES,
  );
  await synchronizer.startSync();
  return {
    store,
    stop: async () => {
      await synchronizer.destroy();
    },
  };
}
