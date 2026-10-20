CREATE TABLE consent_claims (
  handle_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TRIGGER owner_recovery AFTER UPDATE OF session_epoch ON owners
WHEN NEW.session_epoch != OLD.session_epoch
BEGIN
  DELETE FROM passkeys;
  DELETE FROM sessions;
  DELETE FROM auth_challenges;
  DELETE FROM bootstrap_claims;
  DELETE FROM consent_claims;
  UPDATE bots SET status='revoked';
END;
