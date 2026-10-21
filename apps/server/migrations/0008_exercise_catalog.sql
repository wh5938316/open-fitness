-- Shared exercise catalogue. Rows have no owner. Adopted copies live in
-- documents and are not rewritten when this table changes.

CREATE TABLE catalog_exercises (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('exercisedb', 'opengym')),
  catalog_version INTEGER NOT NULL CHECK (catalog_version >= 1),
  data TEXT NOT NULL CHECK (json_valid(data)),
  search_text TEXT NOT NULL,
  body_part TEXT,
  equipment TEXT,
  target TEXT,
  movement_category TEXT,
  needs_rewrite INTEGER NOT NULL DEFAULT 0 CHECK (needs_rewrite IN (0, 1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX catalog_exercises_filter
  ON catalog_exercises(body_part, equipment, target, movement_category);
CREATE INDEX catalog_exercises_source ON catalog_exercises(source);

CREATE TABLE catalog_exercise_i18n (
  exercise_id TEXT NOT NULL REFERENCES catalog_exercises(id),
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN')),
  name TEXT,
  aliases TEXT CHECK (aliases IS NULL OR json_valid(aliases)),
  instructions TEXT,
  provenance TEXT NOT NULL CHECK (json_valid(provenance)),
  PRIMARY KEY (exercise_id, locale)
);

CREATE TABLE catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
