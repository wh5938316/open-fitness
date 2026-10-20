import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureCloudflareResources } from './ensure-cloudflare-resources.mjs';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function wrangler(args) {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'wrangler', ...args],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed`);
  }
}

function deploy() {
  ensureCloudflareResources();
  wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  const args = ['deploy'];
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) args.push('--var', `PUBLIC_BASE_URL:${publicBaseUrl}`);
  const setupToken = process.env.SETUP_TOKEN;
  let secretsDir;
  try {
    if (setupToken) {
      if (setupToken.length < 32) {
        throw new Error('SETUP_TOKEN must be at least 32 characters');
      }
      secretsDir = mkdtempSync(join(tmpdir(), 'openfitness-secrets-'));
      const secretsFile = join(secretsDir, 'secrets.json');
      writeFileSync(secretsFile, JSON.stringify({ SETUP_TOKEN: setupToken }), { mode: 0o600 });
      args.push('--secrets-file', secretsFile);
    }
    wrangler(args);
  } finally {
    if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
  }
  if (!publicBaseUrl) {
    console.info(
      'PUBLIC_BASE_URL was not set. Set it as a Worker var or GitHub variable before using OAuth and passkeys.',
    );
  }
}

try {
  deploy();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
