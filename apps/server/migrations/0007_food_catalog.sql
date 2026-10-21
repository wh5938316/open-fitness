-- Shared Open Food Facts cache, plus one live barcode per owner in foods.
-- catalog_products is reference data and has no owner. Historical meals and
-- recipes are not rewritten. Duplicate barcodes keep the earliest food only.

CREATE TABLE catalog_products (
  code TEXT PRIMARY KEY CHECK (
    length(code) IN (8, 13, 14) AND code NOT GLOB '*[^0-9]*'
  ),
  product_name TEXT NOT NULL,
  brands TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  upstream_modified_at TEXT,
  fetched_at TEXT NOT NULL,
  search_text TEXT NOT NULL
);
CREATE INDEX catalog_products_fetched ON catalog_products(fetched_at);

CREATE TABLE food_barcode_backfill (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  barcode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

INSERT INTO food_barcode_backfill (owner_id, id, barcode, created_at)
SELECT owner_id, id,
  CASE WHEN length(code) = 12 THEN '0' || code ELSE code END,
  created_at
FROM (
  SELECT
    owner_id,
    id,
    created_at,
    substr(
      json_extract(data, '$.source.reference'),
      instr(json_extract(data, '$.source.reference'), '/product/') + length('/product/')
    ) AS code
  FROM documents
  WHERE kind = 'food'
    AND deleted = 0
    AND json_extract(data, '$.source.kind') = 'open_food_facts'
    AND json_extract(data, '$.barcode') IS NULL
    AND instr(coalesce(json_extract(data, '$.source.reference'), ''), '/product/') > 0
)
WHERE code NOT GLOB '*[^0-9]*'
  AND length(code) IN (8, 12, 13, 14);

CREATE TABLE food_barcode_winner (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  barcode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id)
);

INSERT INTO food_barcode_winner (owner_id, id, barcode, created_at)
SELECT owner_id, id, barcode, created_at
FROM food_barcode_backfill AS candidate
WHERE NOT EXISTS (
  SELECT 1
  FROM food_barcode_backfill AS earlier
  WHERE earlier.owner_id = candidate.owner_id
    AND earlier.barcode = candidate.barcode
    AND (
      earlier.created_at < candidate.created_at
      OR (earlier.created_at = candidate.created_at AND earlier.id < candidate.id)
    )
);

UPDATE documents
SET
  version = version + 1,
  updated_at = '2026-10-21T00:00:00.000Z',
  data = json_set(
    data,
    '$.barcode',
    (
      SELECT barcode
      FROM food_barcode_winner
      WHERE food_barcode_winner.owner_id = documents.owner_id
        AND food_barcode_winner.id = documents.id
    )
  )
WHERE kind = 'food'
  AND EXISTS (
    SELECT 1
    FROM food_barcode_winner
    WHERE food_barcode_winner.owner_id = documents.owner_id
      AND food_barcode_winner.id = documents.id
  );

DROP TABLE food_barcode_winner;
DROP TABLE food_barcode_backfill;

CREATE UNIQUE INDEX documents_food_barcode
ON documents (owner_id, json_extract(data, '$.barcode'))
WHERE kind = 'food'
  AND deleted = 0
  AND json_extract(data, '$.barcode') IS NOT NULL;

CREATE INDEX documents_food_barcode_value
ON documents (json_extract(data, '$.barcode'))
WHERE kind = 'food'
  AND deleted = 0
  AND json_extract(data, '$.barcode') IS NOT NULL;
