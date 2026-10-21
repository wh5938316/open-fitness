import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const userIndex = args.indexOf('--user');
const userId = userIndex >= 0 ? args[userIndex + 1] : '';
const remote = args.includes('--remote');
const known = new Set(['--user', '--local', '--remote', userId]);
if (
  !/^[A-Za-z0-9_-]{1,80}$/.test(userId) ||
  (remote && args.includes('--local')) ||
  args.some((arg) => !known.has(arg))
) {
  console.error('Usage: node scripts/recover-user.mjs --user <id> [--local | --remote]');
  console.error(
    'Increments only that user session epoch. Their sessions and agent connections stop working. Other users are unchanged.',
  );
  console.error('--remote is an operator action and is not part of routine verification.');
  process.exit(1);
}
const command = `UPDATE owners SET session_epoch=session_epoch+1 WHERE id='${userId}'`;
const child = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  [
    'exec',
    'wrangler',
    'd1',
    'execute',
    'DB',
    remote ? '--remote' : '--local',
    '--command',
    command,
  ],
  { stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
