import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          PUBLIC_BASE_URL: 'http://localhost:8787',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    })),
  ],
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['./tests/setup.ts'], testTimeout: 30000 },
});
