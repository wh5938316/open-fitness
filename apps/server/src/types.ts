/**
 * Cloudflare Worker bindings and runtime config.
 *
 * Domain code depends on Repository, ObjectStore, CacheStore, and
 * IdentityProvider. This Env type is the Cloudflare entry contract; a later
 * host would supply the same ports from its own bindings.
 */
export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  OAUTH_KV: KVNamespace;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  PUBLIC_BASE_URL?: string;
  SETUP_TOKEN?: string;
  DEFAULT_TIME_ZONE?: string;
  OFF_USER_AGENT?: string;
  MAX_IMAGE_BYTES?: string;
  ALLOWED_ORIGINS?: string;
}

export type Locale = 'en' | 'zh-CN';
export interface Owner {
  id: 'owner';
  locale: Locale | null;
  time_zone: string;
  setup_completed: number;
  session_epoch: number;
}
export interface Actor {
  ownerId: 'owner';
  id: string;
  kind: 'owner' | 'bot';
  locale: Locale;
  timeZone: string;
}
export interface AuthProps {
  ownerId: 'owner';
  botId: string;
  epoch: number;
}
export interface OwnerSession {
  owner: Owner;
  tokenHash: string;
  actor: Actor;
}
export interface IdentityProvider {
  owner(): Promise<Owner>;
  session(request: Request): Promise<OwnerSession | null>;
  ownerActor(owner: Owner, request: Request): Actor;
  botActor(identity: AuthProps, request: Request): Promise<Actor>;
  revokeBot(botId: string): Promise<void>;
}
export type EntityKind = 'exercise' | 'plan' | 'workout' | 'food' | 'recipe' | 'meal' | 'asset';
export interface Entity<T = Record<string, unknown>> {
  id: string;
  kind: EntityKind;
  version: number;
  data: T;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}
export interface Page<T> {
  items: T[];
  cursor: string | null;
}
export interface ListOptions {
  limit?: number;
  cursor?: string;
  query?: string;
  from?: string;
  to?: string;
  field?: 'occurredAt' | 'startedAt';
  exerciseId?: string;
}
export interface Mutation {
  entity: Entity<unknown>;
  expectedVersion?: number;
}
export interface ExportEvent {
  mealId: string;
  version: number;
  action: 'upsert' | 'delete';
  payload: unknown;
}
export interface MediaReference {
  assetId: string | null;
  targetKind: EntityKind;
  targetId: string;
  slot: string;
}
export interface Commit {
  actor: Actor;
  operation: string;
  operationId: string;
  requestHash: string;
  response: unknown;
  mutations: Mutation[];
  exports?: ExportEvent[];
  mediaReferences?: MediaReference[];
  ownerUpdate?: { locale?: Locale; timeZone?: string };
  uploadTicket?: { tokenHash: string; assetId: string; contentType: string; expiresAt: number };
}
export interface Repository {
  get<T = Record<string, unknown>>(
    ownerId: string,
    kind: EntityKind,
    id: string,
  ): Promise<Entity<T> | null>;
  list<T = Record<string, unknown>>(
    ownerId: string,
    kind: EntityKind,
    options?: ListOptions,
  ): Promise<Page<Entity<T>>>;
  revisions(ownerId: string, kind: EntityKind, id: string): Promise<unknown[]>;
  replay(
    ownerId: string,
    operationId: string,
    requestHash: string,
  ): Promise<{ response: unknown } | null>;
  commit(input: Commit): Promise<unknown>;
  healthExports(ownerId: string, limit: number, cursor?: string): Promise<unknown>;
}
export interface ObjectStore {
  put(key: string, body: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream; contentType: string; etag: string } | null>;
  delete(key: string): Promise<void>;
}
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}
