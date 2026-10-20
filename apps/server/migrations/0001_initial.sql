PRAGMA foreign_keys = ON;

CREATE TABLE owners (
  id TEXT PRIMARY KEY CHECK (id = 'owner'),
  locale TEXT CHECK (locale IN ('en', 'zh-CN')),
  time_zone TEXT NOT NULL DEFAULT 'America/New_York',
  setup_completed INTEGER NOT NULL DEFAULT 0,
  session_epoch INTEGER NOT NULL DEFAULT 0
);
INSERT INTO owners(id) VALUES ('owner');

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_hash TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE documents (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL CHECK(kind IN ('exercise','plan','workout','food','recipe','meal','asset')),
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  data TEXT NOT NULL CHECK(json_valid(data)),
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, kind, id)
);
CREATE INDEX documents_list ON documents(owner_id, kind, deleted, created_at DESC, id DESC);
CREATE TABLE document_revisions (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, kind, id, version)
);
CREATE TRIGGER documents_version_guard BEFORE UPDATE ON documents
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'VERSION_CONFLICT'); END;
CREATE TRIGGER documents_insert_revision AFTER INSERT ON documents
BEGIN
  INSERT INTO document_revisions VALUES(NEW.owner_id, NEW.kind, NEW.id, NEW.version, NEW.data, NEW.deleted, NEW.updated_at);
END;
CREATE TRIGGER documents_update_revision AFTER UPDATE ON documents
BEGIN
  INSERT INTO document_revisions VALUES(NEW.owner_id, NEW.kind, NEW.id, NEW.version, NEW.data, NEW.deleted, NEW.updated_at);
END;

CREATE TABLE operations (
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, operation_id)
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE health_exports (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  meal_id TEXT NOT NULL,
  meal_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_device',
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, meal_id, meal_version)
);
CREATE INDEX health_exports_list ON health_exports(owner_id, created_at DESC);

CREATE TABLE media_references (
  owner_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  PRIMARY KEY(owner_id, target_kind, target_id, slot)
);
CREATE INDEX media_references_asset ON media_references(owner_id, asset_id);
CREATE TABLE upload_tickets (
  token_hash TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
