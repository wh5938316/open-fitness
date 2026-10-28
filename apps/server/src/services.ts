import { D1Repository, KVCache, R2ObjectStore } from './adapters/cloudflare';
import { createFoodCatalog } from './adapters/cached-food-catalog';
import { D1HealthSyncStore } from './adapters/cloudflare-health';
import { D1ExerciseCatalog } from './adapters/d1-exercise-catalog';
import { registerHealthOperations } from './domain/health';
import { FitnessService } from './domain/service';
import { MediaService } from './media';
import type { SyncPublisher } from './sync/contract';
import { registerFeedOperations } from './sync/feed';
import type { Actor, Env } from './types';

export function createOwnerServices(
  env: Env,
  actor: Actor,
  origin: string,
  publisher?: SyncPublisher,
) {
  const service = new FitnessService(
    new D1Repository(env.DB),
    actor,
    createFoodCatalog(env),
    new D1ExerciseCatalog(env.DB),
    publisher,
  );
  const media = new MediaService(service, env, new R2ObjectStore(env.MEDIA), origin);
  media.register();
  registerHealthOperations(service, new D1HealthSyncStore(env.DB), new KVCache(env.CACHE));
  registerFeedOperations(service);
  return { service, media };
}
