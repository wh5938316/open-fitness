import { spawn } from 'node:child_process';
const mode = process.argv[2];
if (!['--local', '--remote'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: pnpm owner:recover --local | --remote');
  console.error(
    'This resets every passkey, session, and agent connection. Fitness records are preserved. Set a new SETUP_TOKEN before re-enrolling.',
  );
  process.exit(1);
}
const command =
  "UPDATE owners SET session_epoch=session_epoch+1,setup_completed=0 WHERE id='owner'";
const child = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', 'DB', mode, '--command', command],
  { stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
