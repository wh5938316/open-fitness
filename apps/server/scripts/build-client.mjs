import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('public', { recursive: true });
await build({
  entryPoints: { auth: 'src/web/client.ts' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: 'public',
  splitting: true,
  chunkNames: 'auth-[hash]',
  minify: true,
});
await copyFile(new URL('../../../README.md', import.meta.url), 'public/README.md');
