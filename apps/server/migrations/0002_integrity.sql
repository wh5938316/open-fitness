CREATE TABLE bootstrap_claims (id TEXT PRIMARY KEY CHECK(id='owner'));

CREATE TRIGGER media_reference_guard BEFORE INSERT ON media_references
WHEN NOT EXISTS (
  SELECT 1 FROM documents WHERE owner_id=NEW.owner_id AND kind='asset' AND id=NEW.asset_id
    AND deleted=0 AND json_extract(data,'$.status')='ready'
)
BEGIN SELECT RAISE(ABORT, 'ASSET_NOT_READY'); END;
