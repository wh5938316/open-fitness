import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readD1Migrations } from '@cloudflare/vitest-plugin';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(serverRoot, 'migrations');

function miniflareEntry() {
  const root = join(serverRoot, '../../node_modules/.pnpm');
  const match = readdirSync(root).find((name) => name.startsWith('miniflare@'));
  if (!match) throw new Error('miniflare is not installed');
  return pathToFileURL(join(root, match, 'node_modules/miniflare/dist/src/index.js')).href;
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
    throw new Error(message);
  }
}

function textOf(error) {
  return String(error?.cause?.message ?? error?.message ?? error);
}

const persist = mkdtempSync(join(tmpdir(), 'of-migration-'));
const { Miniflare, convertV4MiniflareOptions } = await import(miniflareEntry());
const miniflare = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { async fetch() { return new Response("ok"); } };',
    d1Databases: { DB: 'migration-check' },
    resourcePersistencePath: persist,
  }),
);

try {
  const db = await miniflare.getD1Database('DB');
  const migrations = await readD1Migrations(migrationsDir);
  const before = migrations.filter((migration) => migration.name < '0005');
  const multiUser = migrations.find((migration) => migration.name.startsWith('0005'));
  assert(before.length >= 4 && multiUser, 'expected migrations 0001 through 0005');
  for (const migration of before)
    await db.batch(migration.queries.map((query) => db.prepare(query)));

  const mealData = '{"name":"Breakfast"}';
  const created = '2026-01-01T00:00:00.000Z';
  await db.batch([
    db
      .prepare(
        'INSERT INTO documents(owner_id,kind,id,version,data,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind('owner', 'meal', 'meal-1', 1, mealData, 0, created, created),
    db
      .prepare(
        'INSERT INTO passkeys(id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind('cred-owner', 'pk', 0, '[]', 'Primary', created),
    db
      .prepare('INSERT INTO sessions(token_hash,epoch,expires_at) VALUES(?,?,?)')
      .bind('sess-owner', 0, 9999999999999),
    db
      .prepare('INSERT INTO bots(id,client_id,name,status,epoch,created_at) VALUES(?,?,?,?,?,?)')
      .bind('bot-owner', 'client', 'Agent', 'active', 0, created),
    db
      .prepare(
        'INSERT INTO auth_challenges(id,challenge,kind,session_hash,expires_at) VALUES(?,?,?,?,?)',
      )
      .bind('ch-owner', 'abc', 'register', 'sess-owner', 9999999999999),
    db.prepare('INSERT INTO bootstrap_claims(id) VALUES(?)').bind('owner'),
    db
      .prepare('INSERT INTO consent_claims(handle_hash,expires_at) VALUES(?,?)')
      .bind('handle-1', 9999999999999),
    db
      .prepare(
        'INSERT INTO upload_tickets(token_hash,asset_id,content_type,expires_at) VALUES(?,?,?,?)',
      )
      .bind('ticket-1', 'asset-1', 'image/png', 9999999999999),
    db
      .prepare(
        'INSERT INTO audit_events(id,actor_id,operation,target_id,created_at) VALUES(?,?,?,?,?)',
      )
      .bind('audit-1', 'owner', 'save_meal', 'meal-1', created),
    db
      .prepare(
        'INSERT INTO health_exports(id,owner_id,meal_id,meal_version,action,payload,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind('exp-1', 'owner', 'meal-1', 1, 'upsert', '{}', created),
    db
      .prepare(
        'INSERT INTO health_devices(id,owner_id,actor_id,name,secret_hash,epoch,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind('dev-1', 'owner', 'owner', 'Phone', 'hash', 0, 'active', created),
    db
      .prepare(
        'UPDATE owners SET locale=?,time_zone=?,setup_completed=1,health_writer_device_id=? WHERE id=?',
      )
      .bind('zh-CN', 'Asia/Shanghai', 'dev-1', 'owner'),
  ]);
  const revisionBefore = await db
    .prepare(
      'SELECT version,data,deleted FROM document_revisions WHERE owner_id=? AND kind=? AND id=? ORDER BY version',
    )
    .bind('owner', 'meal', 'meal-1')
    .all();
  assert(revisionBefore.results.length === 1, 'pre-migration meal should have one revision');

  await db.batch(multiUser.queries.map((query) => db.prepare(query)));

  const owner = await db.prepare('SELECT * FROM owners WHERE id=?').bind('owner').first();
  assert(owner?.locale === 'zh-CN', 'owner locale survived migration');
  assert(owner?.time_zone === 'Asia/Shanghai', 'owner time zone survived migration');
  assert(owner?.setup_completed === 1, 'owner setup flag survived migration');
  assert(owner?.session_epoch === 0, 'owner session epoch survived migration');
  assert(owner?.health_writer_device_id === 'dev-1', 'health writer survived migration');
  assert(owner?.status === 'active', 'migrated owner stays active');
  assert(owner?.clerk_user_id == null, 'clerk user id stays unbound');
  assert(owner?.email == null, 'email stays empty until an operator sets it');
  assert(owner?.created_at == null, 'historical owner creation time stays unknown');

  const meal = await db
    .prepare(
      'SELECT version,data,deleted,created_at,updated_at FROM documents WHERE owner_id=? AND kind=? AND id=?',
    )
    .bind('owner', 'meal', 'meal-1')
    .first();
  assert(
    meal?.data === mealData && meal.version === 1 && meal.deleted === 0,
    'meal document was rewritten',
  );
  assert(meal?.created_at === created && meal?.updated_at === created, 'meal timestamps changed');
  const revisionAfter = await db
    .prepare(
      'SELECT version,data,deleted FROM document_revisions WHERE owner_id=? AND kind=? AND id=? ORDER BY version',
    )
    .bind('owner', 'meal', 'meal-1')
    .all();
  assert(
    JSON.stringify(revisionAfter.results) === JSON.stringify(revisionBefore.results),
    'meal revisions changed during migration',
  );
  const health = await db
    .prepare(
      'SELECT owner_id,meal_id,meal_version,action,payload,status,generation FROM health_exports WHERE id=?',
    )
    .bind('exp-1')
    .first();
  assert(
    health?.owner_id === 'owner' &&
      health.meal_id === 'meal-1' &&
      health.action === 'upsert' &&
      health.payload === '{}' &&
      health.status === 'awaiting_device' &&
      health.generation === 0,
    'health export changed during migration',
  );
  assert(
    (await db.prepare('SELECT owner_id FROM passkeys WHERE id=?').bind('cred-owner').first())
      ?.owner_id === 'owner',
    'passkey lost its owner',
  );
  const session = await db
    .prepare('SELECT owner_id,epoch,clerk_session_id FROM sessions WHERE token_hash=?')
    .bind('sess-owner')
    .first();
  assert(
    session?.owner_id === 'owner' && session.epoch === 0 && session.clerk_session_id == null,
    'session lost its owner',
  );
  assert(
    (await db.prepare('SELECT owner_id,status FROM bots WHERE id=?').bind('bot-owner').first())
      ?.status === 'active',
    'bot was revoked by migration',
  );
  assert(
    (
      await db
        .prepare('SELECT owner_id FROM consent_claims WHERE handle_hash=?')
        .bind('handle-1')
        .first()
    )?.owner_id === 'owner',
    'consent claim lost its owner',
  );
  assert(
    (
      await db
        .prepare('SELECT owner_id FROM upload_tickets WHERE token_hash=?')
        .bind('ticket-1')
        .first()
    )?.owner_id === 'owner',
    'upload ticket lost its owner',
  );
  assert(
    (await db.prepare('SELECT owner_id FROM audit_events WHERE id=?').bind('audit-1').first())
      ?.owner_id === 'owner',
    'audit event lost its owner',
  );

  await expectFailure(
    db,
    'UPDATE documents SET version=?,data=?,updated_at=? WHERE owner_id=? AND kind=? AND id=?',
    [9, '{"name":"Changed"}', '2026-02-01T00:00:00.000Z', 'owner', 'meal', 'meal-1'],
    'VERSION_CONFLICT',
  );
  assert(
    (
      await db
        .prepare('SELECT data FROM documents WHERE owner_id=? AND id=?')
        .bind('owner', 'meal-1')
        .first()
    )?.data === mealData,
    'failed version update changed the meal',
  );
  await expectFailure(
    db,
    'INSERT INTO media_references(owner_id,asset_id,target_kind,target_id,slot) VALUES(?,?,?,?,?)',
    ['owner', 'missing', 'recipe', 'recipe-1', 'cover'],
    'ASSET_NOT_READY',
  );
  await db
    .prepare(
      'INSERT INTO documents(owner_id,kind,id,version,data,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind('owner', 'asset', 'asset-1', 1, '{"status":"ready"}', 0, created, created)
    .run();
  await db
    .prepare(
      'INSERT INTO media_references(owner_id,asset_id,target_kind,target_id,slot) VALUES(?,?,?,?,?)',
    )
    .bind('owner', 'asset-1', 'recipe', 'recipe-1', 'cover')
    .run();
  await expectFailure(
    db,
    "UPDATE health_exports SET generation=1,status='syncing',claimed_device_id=? WHERE id=?",
    ['missing', 'exp-1'],
    'HEALTH_EXPORT_CONFLICT',
  );
  await db
    .prepare(
      "UPDATE health_exports SET generation=1,status='syncing',claimed_device_id=?,lease_expires_at=? WHERE id=?",
    )
    .bind('dev-1', Date.now() + 60000, 'exp-1')
    .run();
  await expectFailure(
    db,
    'UPDATE owners SET health_writer_device_id=? WHERE id=?',
    ['dev-2', 'owner'],
    'HEALTH_WRITER_BUSY',
  );

  await db
    .prepare("INSERT INTO owners(id,status,created_at) VALUES(?,'active',?)")
    .bind('user-b', 1)
    .run();
  await db.batch([
    db
      .prepare(
        'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,created_at) VALUES(?,?,?,?,?)',
      )
      .bind('sess-b', 0, 9999999999999, 'user-b', 1),
    db
      .prepare(
        'INSERT INTO passkeys(id,public_key,counter,transports,name,created_at,owner_id) VALUES(?,?,?,?,?,?,?)',
      )
      .bind('cred-b', 'pk', 0, '[]', 'B', created, 'user-b'),
    db
      .prepare(
        'INSERT INTO bots(id,client_id,name,status,epoch,created_at,owner_id) VALUES(?,?,?,?,?,?,?)',
      )
      .bind('bot-b', 'client', 'B', 'active', 0, created, 'user-b'),
    db
      .prepare(
        'INSERT INTO auth_challenges(id,challenge,kind,session_hash,expires_at) VALUES(?,?,?,?,?)',
      )
      .bind('ch-b', 'abc', 'register', 'sess-b', 9999999999999),
    db
      .prepare(
        'INSERT INTO health_devices(id,owner_id,actor_id,name,secret_hash,epoch,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind('dev-b', 'user-b', 'user-b', 'Phone B', 'hash', 0, 'active', created),
  ]);
  await db
    .prepare('UPDATE owners SET session_epoch=session_epoch+1 WHERE id=?')
    .bind('user-b')
    .run();
  assert(
    (await db
      .prepare('SELECT token_hash FROM sessions WHERE token_hash=?')
      .bind('sess-owner')
      .first()) != null,
    'rotating another owner revoked the bootstrap session',
  );
  assert(
    (await db.prepare('SELECT id FROM passkeys WHERE id=?').bind('cred-owner').first()) != null,
    'rotating another owner deleted the bootstrap passkey',
  );
  assert(
    (await db.prepare('SELECT status FROM bots WHERE id=?').bind('bot-owner').first())?.status ===
      'active',
    'rotating another owner revoked the bootstrap bot',
  );
  assert(
    (await db.prepare('SELECT id FROM auth_challenges WHERE id=?').bind('ch-owner').first()) !=
      null,
    'rotating another owner deleted the bootstrap challenge',
  );
  assert(
    (await db.prepare('SELECT id FROM bootstrap_claims WHERE id=?').bind('owner').first()) != null,
    'rotating another owner cleared bootstrap claims',
  );
  assert(
    (await db.prepare('SELECT status FROM health_devices WHERE id=?').bind('dev-1').first())
      ?.status === 'active',
    'rotating another owner revoked the bootstrap health device',
  );
  assert(
    (await db
      .prepare('SELECT token_hash FROM sessions WHERE token_hash=?')
      .bind('sess-b')
      .first()) == null,
    'rotated owner kept a session',
  );
  assert(
    (await db.prepare('SELECT id FROM passkeys WHERE id=?').bind('cred-b').first()) == null,
    'rotated owner kept a passkey',
  );
  assert(
    (await db.prepare('SELECT status FROM bots WHERE id=?').bind('bot-b').first())?.status ===
      'revoked',
    'rotated owner kept an active bot',
  );
  assert(
    (await db.prepare('SELECT status FROM health_devices WHERE id=?').bind('dev-b').first())
      ?.status === 'revoked',
    'rotated owner kept an active health device',
  );
  assert(
    (
      await db
        .prepare('SELECT health_writer_device_id FROM owners WHERE id=?')
        .bind('user-b')
        .first()
    )?.health_writer_device_id == null,
    'rotated owner kept a health writer',
  );

  await db
    .prepare(
      'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,created_at) VALUES(?,?,?,?,?)',
    )
    .bind('sess-b2', 1, 9999999999999, 'user-b', 2)
    .run();
  await db
    .prepare('UPDATE owners SET session_epoch=session_epoch+1 WHERE id=?')
    .bind('owner')
    .run();
  assert(
    (await db
      .prepare('SELECT token_hash FROM sessions WHERE token_hash=?')
      .bind('sess-owner')
      .first()) == null,
    'bootstrap recovery kept its session',
  );
  assert(
    (await db.prepare('SELECT id FROM bootstrap_claims WHERE id=?').bind('owner').first()) == null,
    'bootstrap recovery kept the setup claim',
  );
  assert(
    (await db
      .prepare('SELECT token_hash FROM sessions WHERE token_hash=?')
      .bind('sess-b2')
      .first()) != null,
    'bootstrap recovery revoked the other owner session',
  );
  assert(
    (
      await db
        .prepare('SELECT data FROM documents WHERE owner_id=? AND id=?')
        .bind('owner', 'meal-1')
        .first()
    )?.data === mealData,
    'bootstrap recovery rewrote the meal',
  );
  await expectFailure(
    db,
    'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id) VALUES(?,?,?,?)',
    ['orphan', 0, 1, 'missing-owner'],
    'FOREIGN KEY',
  );
  const retired = migrations.find((migration) => migration.name.startsWith('0006'));
  assert(retired, 'expected migration 0006');
  await db.batch(retired.queries.map((query) => db.prepare(query)));
  assert(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('passkeys','auth_challenges','bootstrap_claims')",
        )
        .all()
    ).results.length === 0,
    'local auth tables were not dropped',
  );
  await db
    .prepare('UPDATE owners SET session_epoch=session_epoch+1 WHERE id=?')
    .bind('user-b')
    .run();
  assert(
    (await db
      .prepare('SELECT token_hash FROM sessions WHERE token_hash=?')
      .bind('sess-b2')
      .first()) == null,
    'retired recovery kept the rotated user session',
  );
  assert(
    (
      await db
        .prepare('SELECT data FROM documents WHERE owner_id=? AND id=?')
        .bind('owner', 'meal-1')
        .first()
    )?.data === mealData,
    'retiring local auth rewrote the meal',
  );
  const catalogMigration = migrations.find((migration) => migration.name.startsWith('0007'));
  assert(catalogMigration, 'expected migration 0007');
  const offFood = (name, reference) =>
    JSON.stringify({
      name,
      aliases: [],
      nutrients: {
        energyKcal: 1,
        proteinG: null,
        carbohydrateG: null,
        fatG: null,
        fiberG: null,
      },
      basis: { quantity: 100, unit: 'g' },
      preparation: 'as_sold',
      source: { kind: 'open_food_facts', reference, basis: 'Product label.' },
      notes: '',
    });
  const insertFood = (ownerId, id, data, createdAt) =>
    db
      .prepare(
        'INSERT INTO documents(owner_id,kind,id,version,data,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(ownerId, 'food', id, 1, data, 0, createdAt, createdAt);
  await db.batch([
    insertFood(
      'owner',
      'food-early',
      offFood('Early', 'https://world.openfoodfacts.org/product/123456789012'),
      '2026-01-01T00:00:00.000Z',
    ),
    insertFood(
      'owner',
      'food-late',
      offFood('Late', 'https://world.openfoodfacts.org/product/123456789012'),
      '2026-02-01T00:00:00.000Z',
    ),
    insertFood(
      'owner',
      'food-ean8',
      offFood('Short', 'https://world.openfoodfacts.org/product/12345678'),
      '2026-01-02T00:00:00.000Z',
    ),
    insertFood(
      'user-b',
      'food-other-owner',
      offFood('Other', 'https://world.openfoodfacts.org/product/123456789012'),
      '2026-03-01T00:00:00.000Z',
    ),
    insertFood(
      'owner',
      'food-unparsed',
      offFood('Mystery', 'https://example.test/not-a-product'),
      '2026-01-03T00:00:00.000Z',
    ),
  ]);
  const earlyRevisionBefore = await db
    .prepare(
      'SELECT COUNT(*) AS count FROM document_revisions WHERE owner_id=? AND kind=? AND id=?',
    )
    .bind('owner', 'food', 'food-early')
    .first();
  await db.batch(catalogMigration.queries.map((query) => db.prepare(query)));
  const early = await db
    .prepare('SELECT version,data FROM documents WHERE owner_id=? AND id=?')
    .bind('owner', 'food-early')
    .first();
  const earlyData = JSON.parse(early.data);
  assert(early.version === 2, 'backfilled food did not gain a revision version');
  assert(earlyData.barcode === '0123456789012', '12-digit UPC-A was not stored as EAN-13');
  assert(earlyData.name === 'Early', 'backfill rewrote the food name');
  const earlyRevisionAfter = await db
    .prepare(
      'SELECT COUNT(*) AS count FROM document_revisions WHERE owner_id=? AND kind=? AND id=?',
    )
    .bind('owner', 'food', 'food-early')
    .first();
  assert(
    earlyRevisionAfter.count === earlyRevisionBefore.count + 1,
    'backfill did not record a new revision',
  );
  const late = await db
    .prepare('SELECT version,data FROM documents WHERE owner_id=? AND id=?')
    .bind('owner', 'food-late')
    .first();
  assert(
    late.version === 1 && JSON.parse(late.data).barcode === undefined,
    'duplicate barcode was backfilled onto a later food',
  );
  const ean8 = await db
    .prepare("SELECT json_extract(data, '$.barcode') AS barcode FROM documents WHERE id=?")
    .bind('food-ean8')
    .first();
  assert(ean8.barcode === '12345678', 'EAN-8 barcode was not preserved');
  const otherOwner = await db
    .prepare("SELECT json_extract(data, '$.barcode') AS barcode FROM documents WHERE id=?")
    .bind('food-other-owner')
    .first();
  assert(otherOwner.barcode === '0123456789012', 'another owner lost the same barcode');
  const unparsed = await db
    .prepare('SELECT version,data FROM documents WHERE id=?')
    .bind('food-unparsed')
    .first();
  assert(
    unparsed.version === 1 && JSON.parse(unparsed.data).barcode === undefined,
    'unparseable reference was rewritten',
  );
  assert(
    (
      await db
        .prepare('SELECT data FROM documents WHERE owner_id=? AND id=?')
        .bind('owner', 'meal-1')
        .first()
    )?.data === mealData,
    'catalog migration rewrote a meal',
  );
  await expectFailure(
    db,
    'INSERT INTO documents(owner_id,kind,id,version,data,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    [
      'owner',
      'food',
      'food-duplicate',
      1,
      offFood('Duplicate', 'https://world.openfoodfacts.org/product/0123456789012').replace(
        '"notes":""',
        '"notes":"","barcode":"0123456789012"',
      ),
      0,
      '2026-04-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ],
    'documents_food_barcode',
  );
  const catalog = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_products'")
    .first();
  assert(catalog?.name === 'catalog_products', 'catalog_products was not created');
  const exerciseMigration = migrations.find((migration) => migration.name.startsWith('0008'));
  assert(exerciseMigration, 'expected migration 0008');
  const mealBeforeExerciseMigration = await db
    .prepare('SELECT version,data,updated_at FROM documents WHERE owner_id=? AND id=?')
    .bind('owner', 'meal-1')
    .first();
  await db.batch(exerciseMigration.queries.map((query) => db.prepare(query)));
  const mealAfterExerciseMigration = await db
    .prepare('SELECT version,data,updated_at FROM documents WHERE owner_id=? AND id=?')
    .bind('owner', 'meal-1')
    .first();
  assert(
    JSON.stringify(mealAfterExerciseMigration) === JSON.stringify(mealBeforeExerciseMigration),
    'exercise catalogue migration rewrote a meal',
  );
  assert(
    (
      await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_exercises'")
        .first()
    )?.name === 'catalog_exercises',
    'catalog_exercises was not created',
  );
  assert(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_exercise_i18n'",
        )
        .first()
    )?.name === 'catalog_exercise_i18n',
    'catalog_exercise_i18n was not created',
  );
  await db
    .prepare(
      `INSERT INTO catalog_exercises(
        id, external_id, source, catalog_version, data, search_text,
        body_part, equipment, target, movement_category, needs_rewrite, updated_at
      ) VALUES ('cat-0001','0001','exercisedb',1,'{"name":"Example"}','example','waist','body weight','abs','strength',0,'2026-10-21T00:00:00.000Z')`,
    )
    .run();
  const i18nDescription = migrations.find((migration) => migration.name.startsWith('0009'));
  assert(i18nDescription, 'expected migration 0009');
  await db.batch(i18nDescription.queries.map((query) => db.prepare(query)));
  const descriptionColumn = await db.prepare(`PRAGMA table_info('catalog_exercise_i18n')`).all();
  assert(
    descriptionColumn.results.some((column) => column.name === 'description'),
    'catalog_exercise_i18n.description was not added',
  );
  console.log('migration 0005 preserved owner data and per-owner recovery');
  console.log('migration 0006 removed local WebAuthn tables');
  console.log('migration 0007 backfilled the earliest food barcode per owner');
  console.log('migration 0008 added the global exercise catalogue');
  console.log('migration 0009 added Chinese exercise descriptions');
} finally {
  await miniflare.dispose();
  rmSync(persist, { recursive: true, force: true });
}

async function expectFailure(db, sql, values, marker) {
  try {
    await db
      .prepare(sql)
      .bind(...values)
      .run();
  } catch (error) {
    assert(textOf(error).includes(marker), `expected ${marker} but got ${textOf(error)}`);
    return;
  }
  assert(false, `expected ${marker}`);
}

if (process.exitCode) process.exit(process.exitCode);
