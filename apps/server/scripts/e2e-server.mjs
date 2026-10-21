import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const clerkPrefix = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';
function pem(label, bytes) {
  const encoded = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const lines = encoded.match(/.{1,64}/g)?.join('\n') ?? encoded;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
async function generateClerkTestKeys() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign'],
    );
    const publicPem = pem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey));
    const body = publicPem.replace(/-----BEGIN.*?-----|-----END.*?-----|\s/g, '');
    if (!body.startsWith(clerkPrefix) || !body.endsWith('IDAQAB')) continue;
    return {
      publicPem,
      privatePem: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    };
  }
  throw new Error('Could not generate a Clerk-compatible RSA key for end-to-end tests.');
}

const state = resolve('.wrangler/e2e-state');
await rm(state, { recursive: true, force: true });
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const command = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
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
const clerkKeys = await generateClerkTestKeys();
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
    'CLERK_TEST_MODE:1',
    '--var',
    'CLERK_AUTO_PROVISION:true',
    '--var',
    'CLERK_JWT_KEY:' + clerkKeys.publicPem.replaceAll('\n', ''),
    '--var',
    'CLERK_TEST_PRIVATE_KEY:' + clerkKeys.privatePem.replaceAll('\n', ''),
  ],
  { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
