import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(serverRoot, 'wrangler.jsonc');

const D1_NAME = 'open-fitness';
const R2_NAME = 'open-fitness-media';
const KV_TITLES = {
  OAUTH_KV: ['open-fitness-OAUTH_KV', 'OAUTH_KV'],
  CACHE: ['open-fitness-CACHE', 'CACHE'],
};

function wrangler(args) {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'wrangler', ...args],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed:\n${stderr || stdout}`);
  }
  return { stdout, stderr };
}

function parseJsonOutput(text) {
  const start = text.search(/[\[{]/);
  if (start < 0) throw new Error(`No JSON in Wrangler output:\n${text}`);
  return JSON.parse(text.slice(start));
}

function requireCredentials() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to create or look up Cloudflare resources.',
    );
  }
}

function replaceOnce(source, pattern, value, label) {
  const next = source.replace(pattern, value);
  if (next === source) throw new Error(`Could not update ${label} in wrangler.jsonc`);
  return next;
}

function writeBindingIds(ids) {
  let source = readFileSync(configPath, 'utf8');
  source = replaceOnce(
    source,
    /("database_id":\s*")[^"]+(")/,
    `$1${ids.databaseId}$2`,
    'D1 database_id',
  );
  source = replaceOnce(
    source,
    /("binding":\s*"OAUTH_KV",\s*"id":\s*")[^"]+(")/,
    `$1${ids.oauthKvId}$2`,
    'OAUTH_KV id',
  );
  source = replaceOnce(
    source,
    /("binding":\s*"CACHE",\s*"id":\s*")[^"]+(")/,
    `$1${ids.cacheKvId}$2`,
    'CACHE id',
  );
  writeFileSync(configPath, source);
}

function d1IdFromList(name) {
  const listed = parseJsonOutput(wrangler(['d1', 'list', '--json']).stdout);
  const match = listed.find((item) => item.name === name);
  return match?.uuid ?? match?.id ?? null;
}

function ensureD1() {
  const existing = d1IdFromList(D1_NAME);
  if (existing) return existing;
  console.info(`Creating D1 database ${D1_NAME}`);
  wrangler(['d1', 'create', D1_NAME]);
  const created = d1IdFromList(D1_NAME);
  if (!created) throw new Error(`Created D1 database ${D1_NAME} but could not read its ID`);
  return created;
}

function kvNamespaces() {
  return parseJsonOutput(wrangler(['kv', 'namespace', 'list']).stdout);
}

function findKv(namespaces, titles) {
  const wanted = new Set(titles);
  const match = namespaces.find((item) => wanted.has(item.title));
  return match?.id ?? null;
}

function ensureKv(binding) {
  const titles = KV_TITLES[binding];
  const existing = findKv(kvNamespaces(), titles);
  if (existing) return existing;
  const title = titles[0];
  console.info(`Creating KV namespace ${title}`);
  wrangler(['kv', 'namespace', 'create', title]);
  const created = findKv(kvNamespaces(), titles);
  if (!created) throw new Error(`Created KV namespace ${title} but could not read its ID`);
  return created;
}

function r2Exists() {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'wrangler', 'r2', 'bucket', 'info', R2_NAME, '--json'],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  return result.status === 0;
}

function ensureR2() {
  if (r2Exists()) return;
  console.info(`Creating R2 bucket ${R2_NAME}`);
  wrangler(['r2', 'bucket', 'create', R2_NAME]);
}

export function ensureCloudflareResources() {
  requireCredentials();
  const databaseId = ensureD1();
  const oauthKvId = ensureKv('OAUTH_KV');
  const cacheKvId = ensureKv('CACHE');
  ensureR2();
  writeBindingIds({ databaseId, oauthKvId, cacheKvId });
  console.info(
    JSON.stringify({
      event: 'cloudflare_resources_ready',
      d1: { name: D1_NAME, id: databaseId },
      r2: { name: R2_NAME },
      kv: { OAUTH_KV: oauthKvId, CACHE: cacheKvId },
    }),
  );
  return { databaseId, oauthKvId, cacheKvId };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    ensureCloudflareResources();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
