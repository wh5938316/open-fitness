-- Chinese descriptions live beside the translated name. Existing rows stay valid
-- with a null description until the catalogue seed fills them in.

ALTER TABLE catalog_exercise_i18n ADD COLUMN description TEXT;
