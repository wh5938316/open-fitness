import { foodSchema } from '../domain/schemas';
import { containsLike } from '../domain/search';
import type { CatalogRecord, FoodCatalogStore } from '../domain/catalog';

interface CatalogRow {
  code: string;
  product_name: string;
  brands: string | null;
  payload: string;
  upstream_modified_at: string | null;
  fetched_at: string;
}

function record(row: CatalogRow): CatalogRecord | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  const food = foodSchema.safeParse(payload);
  if (!food.success || food.data.barcode !== row.code) return null;
  return {
    code: row.code,
    productName: row.product_name,
    brands: row.brands,
    food: food.data,
    upstreamModifiedAt: row.upstream_modified_at,
    fetchedAt: row.fetched_at,
  };
}

export class D1FoodCatalogStore implements FoodCatalogStore {
  constructor(private db: D1Database) {}

  async get(code: string): Promise<CatalogRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM catalog_products WHERE code=?')
      .bind(code)
      .first<CatalogRow>();
    return row ? record(row) : null;
  }

  async search(query: string, limit: number): Promise<CatalogRecord[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM catalog_products WHERE search_text LIKE ? ESCAPE '\\' ORDER BY fetched_at DESC LIMIT ?",
      )
      .bind(containsLike(query), limit)
      .all<CatalogRow>();
    return rows.results.flatMap((row) => {
      const item = record(row);
      return item ? [item] : [];
    });
  }

  async upsert(item: CatalogRecord): Promise<void> {
    const searchText = [item.productName, item.brands ?? '', item.code].join(' ').toLowerCase();
    await this.db
      .prepare(
        `INSERT INTO catalog_products(
           code, product_name, brands, payload, upstream_modified_at, fetched_at, search_text
         ) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET
           product_name=excluded.product_name,
           brands=excluded.brands,
           payload=excluded.payload,
           upstream_modified_at=excluded.upstream_modified_at,
           fetched_at=excluded.fetched_at,
           search_text=excluded.search_text`,
      )
      .bind(
        item.code,
        item.productName,
        item.brands,
        JSON.stringify(item.food),
        item.upstreamModifiedAt,
        item.fetchedAt,
        searchText,
      )
      .run();
  }

  async staleReferenced(olderThan: string, limit: number): Promise<CatalogRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT catalog_products.* FROM catalog_products
         WHERE fetched_at < ?
           AND EXISTS (
             SELECT 1 FROM documents
             WHERE kind='food' AND deleted=0
               AND json_extract(documents.data, '$.barcode') = catalog_products.code
           )
         ORDER BY fetched_at ASC
         LIMIT ?`,
      )
      .bind(olderThan, limit)
      .all<CatalogRow>();
    return rows.results.flatMap((row) => {
      const item = record(row);
      return item ? [item] : [];
    });
  }
}
