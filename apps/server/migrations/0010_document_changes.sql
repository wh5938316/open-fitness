-- Native change feed. One row per document; every insert or update deletes the
-- previous row and inserts a new one so seq increases. Rebuilding `documents`
-- (as 0005_multi_user.sql did) drops triggers. Recreate documents_insert_change
-- and documents_update_change in the same migration that rebuilds the table.

CREATE TABLE document_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  UNIQUE (owner_id, kind, id)
);
CREATE INDEX document_changes_owner_seq ON document_changes (owner_id, seq);

CREATE TRIGGER documents_insert_change
AFTER INSERT ON documents
BEGIN
  DELETE FROM document_changes
  WHERE owner_id = NEW.owner_id AND kind = NEW.kind AND id = NEW.id;
  INSERT INTO document_changes (owner_id, kind, id, version)
  VALUES (NEW.owner_id, NEW.kind, NEW.id, NEW.version);
END;

CREATE TRIGGER documents_update_change
AFTER UPDATE ON documents
BEGIN
  DELETE FROM document_changes
  WHERE owner_id = NEW.owner_id AND kind = NEW.kind AND id = NEW.id;
  INSERT INTO document_changes (owner_id, kind, id, version)
  VALUES (NEW.owner_id, NEW.kind, NEW.id, NEW.version);
END;

INSERT INTO document_changes (owner_id, kind, id, version)
SELECT owner_id, kind, id, version
FROM documents
ORDER BY updated_at, kind, id;
