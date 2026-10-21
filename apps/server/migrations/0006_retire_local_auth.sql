-- Retire the self-hosted WebAuthn tables. Clerk passkeys replace them.
-- Sessions, consent claims, and bots stay, and recovery remains scoped to one owner.
DROP TRIGGER owner_recovery;

DROP TABLE passkeys;
DROP TABLE auth_challenges;
DROP TABLE bootstrap_claims;

CREATE TRIGGER owner_recovery AFTER UPDATE OF session_epoch ON owners
WHEN NEW.session_epoch != OLD.session_epoch
BEGIN
  DELETE FROM sessions WHERE owner_id=NEW.id;
  DELETE FROM consent_claims WHERE owner_id=NEW.id;
  UPDATE bots SET status='revoked' WHERE owner_id=NEW.id;
END;
