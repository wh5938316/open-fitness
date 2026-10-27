import type { Env } from '../types';

/** Asks connected native clients to pull. A failed poke never fails the write. */
export async function notifyOwner(env: Env, ownerId: string): Promise<void> {
  try {
    const stub = env.FITNESS_EVENTS.get(env.FITNESS_EVENTS.idFromName(ownerId));
    await stub.notify();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'sync_notify_failed',
        code: error instanceof Error ? error.name : 'INTERNAL_ERROR',
      }),
    );
  }
}
