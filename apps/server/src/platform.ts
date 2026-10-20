import { D1Repository, KVCache, R2ObjectStore } from './adapters/cloudflare';
import type { CacheStore, Env, ObjectStore, Repository } from './types';

/**
 * Portable persistence ports. Cloudflare is the first runtime; a later host
 * (for example Vercel) should implement the same interfaces rather than
 * rewriting domain services.
 */
export interface Platform {
  repository: Repository;
  objects: ObjectStore;
  cache: CacheStore;
}

export function createCloudflarePlatform(env: Env): Platform {
  return {
    repository: new D1Repository(env.DB),
    objects: new R2ObjectStore(env.MEDIA),
    cache: new KVCache(env.CACHE),
  };
}
