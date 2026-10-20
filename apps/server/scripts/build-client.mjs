import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('public', { recursive: true });
await build({
  entryPoints: ['src/web/client.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'public/auth.js',
  minify: true,
});
await copyFile(new URL('../../../README.md', import.meta.url), 'public/README.md');
