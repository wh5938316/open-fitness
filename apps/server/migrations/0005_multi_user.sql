-- Multi-user tenancy. Existing rows stay on id 'owner'; Clerk ids are a mapping,
-- not a partition key. Revisions and R2 objects are not touched.
-- D1 keeps foreign keys enabled inside a migration batch, so a parent table that
-- already has child rows cannot be dropped in place. Document and health-device
-- rows are copied unchanged onto tables that reference the rebuilt owners table.
PRAGMA defer_foreign_keys = true;

DROP TRIGGER health_export_claim_guard;
DROP TRIGGER health_device_recovery;
DROP TRIGGER health_writer_switch_guard;
DROP TRIGGER media_reference_guard;

CREATE TABLE owners_next (
  id TEXT PRIMARY KEY,
  locale TEXT CHECK (locale IN ('en', 'zh-CN')),
  time_zone TEXT NOT NULL DEFAULT 'America/New_York',
  setup_completed INTEGER NOT NULL DEFAULT 0,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  health_writer_device_id TEXT,
  clerk_user_id TEXT UNIQUE,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER
);

INSERT INTO owners_next (
  id, locale, time_zone, setup_completed, session_epoch, health_writer_device_id,
  clerk_user_id, email, status, created_at
)
SELECT
  id, locale, time_zone, setup_completed, session_epoch, health_writer_device_id,
  NULL, NULL, 'active', NULL
FROM owners;

CREATE TABLE documents_next (
  owner_id TEXT NOT NULL REFERENCES owners_next(id),
  kind TEXT NOT NULL CHECK(kind IN ('exercise','plan','workout','food','recipe','meal','asset')),
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  data TEXT NOT NULL CHECK(json_valid(data)),
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, kind, id)
);
INSERT INTO documents_next SELECT * FROM documents;
DROP TABLE documents;
ALTER TABLE documents_next RENAME TO documents;
CREATE INDEX documents_list ON documents(owner_id, kind, deleted, created_at DESC, id DESC);

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

CREATE TABLE health_devices_next (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners_next(id),
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL
);
INSERT INTO health_devices_next SELECT * FROM health_devices;
DROP TABLE health_devices;
ALTER TABLE health_devices_next RENAME TO health_devices;

DROP TABLE owners;
ALTER TABLE owners_next RENAME TO owners;

CREATE TRIGGER media_reference_guard BEFORE INSERT ON media_references
WHEN NOT EXISTS (
  SELECT 1 FROM documents WHERE owner_id=NEW.owner_id AND kind='asset' AND id=NEW.asset_id
    AND deleted=0 AND json_extract(data,'$.status')='ready'
)
BEGIN SELECT RAISE(ABORT, 'ASSET_NOT_READY'); END;

CREATE TRIGGER health_export_claim_guard BEFORE UPDATE ON health_exports
WHEN NEW.status = 'syncing' AND (
  OLD.status IN ('synced','superseded') OR
  (OLD.status = 'syncing' AND OLD.lease_expires_at > unixepoch('subsec') * 1000) OR
  NOT EXISTS (
    SELECT 1 FROM owners JOIN health_devices ON health_devices.id = NEW.claimed_device_id
    WHERE owners.id = NEW.owner_id AND owners.health_writer_device_id = health_devices.id
      AND health_devices.owner_id = owners.id AND health_devices.status = 'active'
      AND health_devices.epoch = owners.session_epoch
  )
)
BEGIN SELECT RAISE(ABORT, 'HEALTH_EXPORT_CONFLICT'); END;

CREATE TRIGGER health_device_recovery AFTER UPDATE OF session_epoch ON owners
WHEN NEW.session_epoch != OLD.session_epoch
BEGIN
  UPDATE health_devices SET status='revoked' WHERE owner_id=NEW.id;
  UPDATE owners SET health_writer_device_id=NULL WHERE id=NEW.id;
END;

CREATE TRIGGER health_writer_switch_guard BEFORE UPDATE OF health_writer_device_id ON owners
WHEN NEW.health_writer_device_id IS NOT NULL
  AND NEW.health_writer_device_id IS NOT OLD.health_writer_device_id
  AND EXISTS (
    SELECT 1 FROM health_exports
    WHERE owner_id=NEW.id AND status='syncing' AND lease_expires_at>unixepoch('subsec')*1000
  )
BEGIN SELECT RAISE(ABORT, 'HEALTH_WRITER_BUSY'); END;

-- SQLite rejects ADD COLUMN ... REFERENCES ... NOT NULL DEFAULT when rows exist.
-- Rebuild the small auth tables and copy every existing row onto owner id 'owner'.
CREATE TABLE sessions_next (
  token_hash TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  owner_id TEXT NOT NULL DEFAULT 'owner' REFERENCES owners(id),
  clerk_session_id TEXT,
  created_at INTEGER
);
INSERT INTO sessions_next (token_hash, epoch, expires_at, owner_id)
SELECT token_hash, epoch, expires_at, 'owner' FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_next RENAME TO sessions;

CREATE TABLE bots_next (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT 'owner' REFERENCES owners(id)
);
INSERT INTO bots_next (id, client_id, name, status, epoch, created_at, owner_id)
SELECT id, client_id, name, status, epoch, created_at, 'owner' FROM bots;
DROP TABLE bots;
ALTER TABLE bots_next RENAME TO bots;

CREATE TABLE consent_claims_next (
  handle_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  owner_id TEXT NOT NULL DEFAULT 'owner' REFERENCES owners(id)
);
INSERT INTO consent_claims_next (handle_hash, expires_at, owner_id)
SELECT handle_hash, expires_at, 'owner' FROM consent_claims;
DROP TABLE consent_claims;
ALTER TABLE consent_claims_next RENAME TO consent_claims;

CREATE TABLE upload_tickets_next (
  token_hash TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  owner_id TEXT NOT NULL DEFAULT 'owner' REFERENCES owners(id)
);
INSERT INTO upload_tickets_next (token_hash, asset_id, content_type, expires_at, used_at, owner_id)
SELECT token_hash, asset_id, content_type, expires_at, used_at, 'owner' FROM upload_tickets;
DROP TABLE upload_tickets;
ALTER TABLE upload_tickets_next RENAME TO upload_tickets;

CREATE TABLE audit_events_next (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT,
  created_at TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT 'owner' REFERENCES owners(id)
);
INSERT INTO audit_events_next (id, actor_id, operation, target_id, created_at, owner_id)
SELECT id, actor_id, operation, target_id, created_at, 'owner' FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_next RENAME TO audit_events;

CREATE TABLE passkeys_next (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT 'owner' REFERENCES owners(id)
);
INSERT INTO passkeys_next (id, public_key, counter, transports, name, created_at, owner_id)
SELECT id, public_key, counter, transports, name, created_at, 'owner' FROM passkeys;
DROP TABLE passkeys;
ALTER TABLE passkeys_next RENAME TO passkeys;

CREATE INDEX sessions_owner_id ON sessions(owner_id);
CREATE INDEX sessions_clerk_session_id ON sessions(clerk_session_id);
CREATE INDEX bots_owner_id ON bots(owner_id);
CREATE INDEX consent_claims_owner_id ON consent_claims(owner_id);
CREATE INDEX upload_tickets_owner_id ON upload_tickets(owner_id);
CREATE INDEX audit_events_owner_id ON audit_events(owner_id);
CREATE INDEX passkeys_owner_id ON passkeys(owner_id);

-- auth_challenges stay unscoped: authentication starts before a passkey identifies
-- the owner. Challenges bound to a session are removed with that owner.
CREATE TRIGGER owner_recovery AFTER UPDATE OF session_epoch ON owners
WHEN NEW.session_epoch != OLD.session_epoch
BEGIN
  DELETE FROM auth_challenges WHERE session_hash IN (
    SELECT token_hash FROM sessions WHERE owner_id=NEW.id
  );
  DELETE FROM bootstrap_claims WHERE id=NEW.id;
  DELETE FROM passkeys WHERE owner_id=NEW.id;
  DELETE FROM sessions WHERE owner_id=NEW.id;
  DELETE FROM consent_claims WHERE owner_id=NEW.id;
  UPDATE bots SET status='revoked' WHERE owner_id=NEW.id;
END;
