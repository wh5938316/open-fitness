ALTER TABLE owners ADD COLUMN health_writer_device_id TEXT;
ALTER TABLE health_exports ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE health_exports ADD COLUMN claimed_device_id TEXT;
ALTER TABLE health_exports ADD COLUMN lease_token_hash TEXT;
ALTER TABLE health_exports ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE health_exports ADD COLUMN delivered_at TEXT;
ALTER TABLE health_exports ADD COLUMN error_code TEXT;

CREATE TABLE health_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL
);

CREATE TRIGGER health_export_generation_guard BEFORE UPDATE ON health_exports
WHEN NEW.generation != OLD.generation + 1
BEGIN SELECT RAISE(ABORT, 'HEALTH_EXPORT_CONFLICT'); END;

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

CREATE INDEX health_exports_pending ON health_exports(owner_id,status,created_at);

CREATE TRIGGER health_writer_switch_guard BEFORE UPDATE OF health_writer_device_id ON owners
WHEN NEW.health_writer_device_id IS NOT NULL AND NEW.health_writer_device_id IS NOT OLD.health_writer_device_id
  AND EXISTS(SELECT 1 FROM health_exports WHERE owner_id=NEW.id AND status='syncing' AND lease_expires_at>unixepoch('subsec')*1000)
BEGIN SELECT RAISE(ABORT, 'HEALTH_WRITER_BUSY'); END;
