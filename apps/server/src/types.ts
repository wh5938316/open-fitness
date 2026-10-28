import type { FitnessEventsDurableObject } from './sync/events';
import type { FitnessSyncDurableObject } from './sync/object';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  OAUTH_KV: KVNamespace;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  FITNESS_SYNC: DurableObjectNamespace<FitnessSyncDurableObject>;
  FITNESS_EVENTS: DurableObjectNamespace<FitnessEventsDurableObject>;
  PUBLIC_BASE_URL?: string;
  DEFAULT_TIME_ZONE?: string;
  OFF_USER_AGENT?: string;
  MAX_IMAGE_BYTES?: string;
  ALLOWED_ORIGINS?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_JWT_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_FRONTEND_API?: string;
  CLERK_AUTO_PROVISION?: string;
  CLERK_TEST_MODE?: string;
  CLERK_TEST_PRIVATE_KEY?: string;
  CLERK_WEBHOOK_SECRET?: string;
}
export interface ExternalIdentity {
  subject: string;
  sessionId: string;
  issuedAt: number;
}
export interface ExternalIdentityVerifier {
  verifySessionToken(token: string): Promise<ExternalIdentity>;
  fetchProfile(subject: string): Promise<{ email: string | null }>;
}

export type Locale = 'en' | 'zh-CN';
export interface Owner {
  id: string;
  locale: Locale | null;
  time_zone: string;
  setup_completed: number;
  session_epoch: number;
  health_writer_device_id: string | null;
  clerk_user_id: string | null;
  email: string | null;
  status: 'active' | 'disabled';
  created_at: number | null;
}
export interface Actor {
  ownerId: string;
  id: string;
  kind: 'owner' | 'bot';
  locale: Locale;
  timeZone: string;
  scopes?: readonly string[];
}
export interface AuthProps {
  ownerId: string;
  botId: string;
  epoch: number;
}
export interface OwnerSession {
  owner: Owner;
  tokenHash: string;
  actor: Actor;
  /** Absolute session expiry in milliseconds since the epoch. */
  expiresAt: number;
}
export interface IdentityProvider {
  owner(id?: string): Promise<Owner>;
  session(request: Request): Promise<OwnerSession | null>;
  ownerActor(owner: Owner, request: Request): Actor;
  botActor(identity: AuthProps, request: Request, scopes?: readonly string[]): Promise<Actor>;
  revokeBot(ownerId: string, botId: string): Promise<void>;
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
export interface ChangeItem<T = Record<string, unknown>> extends Entity<T> {
  seq: number;
  deleted: boolean;
}
export interface ChangePage<T = Record<string, unknown>> {
  items: ChangeItem<T>[];
  lastSeq: number;
  hasMore: boolean;
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
  healthMutation?: import('./domain/health').HealthMutation;
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
  getAny<T = Record<string, unknown>>(
    ownerId: string,
    kind: EntityKind,
    id: string,
  ): Promise<Entity<T> | null>;
  searchOwnedExercises<T = Record<string, unknown>>(
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
  ): Promise<{ items: Entity<T>[]; cursor: { date: string; id: string } | null }>;
  revisions(ownerId: string, kind: EntityKind, id: string): Promise<unknown[]>;
  replay(
    ownerId: string,
    operationId: string,
    requestHash: string | readonly string[],
  ): Promise<{ response: unknown } | null>;
  /**
   * Latest version of each document changed after `afterSeq`, tombstones included.
   * `seq` is assigned inside the same commit as the document write. D1 serializes
   * writers, so seq order is commit order and a reader never observes a gap from an
   * in-flight transaction. A future Postgres adapter needs a commit-ordered log
   * assigned in that same transaction, not a wall-clock timestamp.
   */
  changes(ownerId: string, afterSeq: number, limit: number, maxBytes: number): Promise<ChangePage>;
  findFoodByBarcode<T = Record<string, unknown>>(
    ownerId: string,
    barcode: string,
  ): Promise<Entity<T> | null>;
  listFoodBarcodes(ownerId: string): Promise<string[]>;
  exportDocuments(ownerId: string): Promise<Entity[]>;
  commit(input: Commit): Promise<unknown>;
  commitDetailed(input: Commit): Promise<{ response: unknown; replayed: boolean }>;
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
