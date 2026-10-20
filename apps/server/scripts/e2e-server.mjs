import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const state = resolve('.wrangler/e2e-state');
await rm(state, { recursive: true, force: true });
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const wranglerEnv = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false',
  SETUP_TOKEN: 'e2e-only-setup-token-with-more-than-32-characters',
};
const command = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: 'inherit',
      env: wranglerEnv,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed with exit code ${code}`)),
    );
  });
await command(['build:client']);
await command([
  'exec',
  'wrangler',
  'd1',
  'migrations',
  'apply',
  'DB',
  '--local',
  '--persist-to',
  state,
]);
const child = spawn(
  executable,
  [
    'exec',
    'wrangler',
    'dev',
    '--port',
    '18787',
    '--ip',
    '127.0.0.1',
    '--persist-to',
    state,
    '--var',
    'PUBLIC_BASE_URL:http://localhost:18787',
    '--var',
    'SETUP_TOKEN:e2e-only-setup-token-with-more-than-32-characters',
  ],
  { stdio: 'inherit', env: wranglerEnv },
);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
