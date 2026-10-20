# Deploy OpenFitness

OpenFitness v1 is a single Cloudflare Worker in `apps/server`. It serves MCP, REST, owner setup pages, and static assets (`public/`). There is no Cloudflare Pages project and no iOS or Android app in this repository yet.

Cloudflare is the first runtime. Domain services talk to `Repository`, `ObjectStore`, `CacheStore`, and `IdentityProvider`. The Worker entry (`src/index.ts`) and `createCloudflarePlatform()` are the Cloudflare adapter. Do not treat an unimplemented host as working.

## Required Cloudflare resources

Create these in the target account, or let `pnpm deploy` create them by name:

| Resource     | Name                                    | Worker binding | Purpose                                                 |
| ------------ | --------------------------------------- | -------------- | ------------------------------------------------------- |
| Worker       | `open-fitness`                          | —              | HTTP, MCP, cron                                         |
| D1           | `open-fitness`                          | `DB`           | Business records, revisions, auth, health outbox        |
| R2 bucket    | `open-fitness-media`                    | `MEDIA`        | Private processed images. Keep public access off.       |
| KV namespace | `open-fitness-OAUTH_KV` (or `OAUTH_KV`) | `OAUTH_KV`     | OAuth clients, grants, and tokens                       |
| KV namespace | `open-fitness-CACHE` (or `CACHE`)       | `CACHE`        | Open Food Facts cache, rate limits, maintenance cursors |

Schema lives in numbered files under `apps/server/migrations/`. Remote apply is part of `pnpm deploy`.

Placeholder D1 and KV IDs in `apps/server/wrangler.jsonc` are for local Miniflare only. The deploy script looks up or creates the named resources and writes real IDs into the working copy. Resource IDs are not secrets; you may commit them after the first provision.

## Secrets and variables

### GitHub Actions (repository)

| Name                    | Kind     | Required                  | Notes                                                                                                                                                                          |
| ----------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | secret   | yes                       | Use a token with the **Edit Cloudflare Workers** template, including D1, KV, and R2 edit. Scope it to this account.                                                            |
| `CLOUDFLARE_ACCOUNT_ID` | secret   | yes                       | Account ID from the Cloudflare dashboard.                                                                                                                                      |
| `SETUP_TOKEN`           | secret   | yes for first owner setup | Random secret, at least 32 characters. Rotating it does not wipe fitness data.                                                                                                 |
| `PUBLIC_BASE_URL`       | variable | yes before passkeys/OAuth | Canonical HTTPS origin with no path, query, or trailing slash, for example `https://open-fitness.<subdomain>.workers.dev`. This hostname is the passkey RP ID. Keep it stable. |

Wrangler also reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment for CLI deploys.

### Worker runtime

| Name                | How to set              | Notes                                                                                                                        |
| ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_TOKEN`       | Worker secret           | CI passes it with `--secrets-file` when the GitHub secret is present. Existing secrets are not deleted on deploy.            |
| `PUBLIC_BASE_URL`   | Worker var              | CI sets it from the GitHub variable when present. `keep_vars` is enabled so a dashboard value survives deploys that omit it. |
| `DEFAULT_TIME_ZONE` | `wrangler.jsonc` `vars` | Default `America/New_York`.                                                                                                  |
| `OFF_USER_AGENT`    | `wrangler.jsonc` `vars` | Open Food Facts user agent.                                                                                                  |
| `MAX_IMAGE_BYTES`   | `wrangler.jsonc` `vars` | Default 10 MiB.                                                                                                              |
| `ALLOWED_ORIGINS`   | optional Worker var     | Extra browser origins for MCP/REST. Same-origin is always allowed.                                                           |

Generate a setup token:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("base64url"))'
```

## One-time setup

1. Create a Cloudflare account and API token as above.
2. Add the GitHub secrets and the `PUBLIC_BASE_URL` variable. If the `*.workers.dev` subdomain is not known yet, deploy once, copy the printed Worker URL, set `PUBLIC_BASE_URL`, and deploy again.
3. Push to `main` or run **Deploy** from Actions (`workflow_dispatch`). The workflow runs `pnpm deploy`, which:
   - builds owner-page JavaScript
   - creates or reuses D1, R2, and KV
   - applies D1 migrations remotely
   - deploys the Worker
4. Open `https://YOUR_HOST/setup`, enter `SETUP_TOKEN`, and register a passkey. Add a backup authenticator from `/admin`.
5. Point MCP clients at `https://YOUR_HOST/mcp`.

Manual equivalent from a trusted machine:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export PUBLIC_BASE_URL=https://open-fitness.<subdomain>.workers.dev
export SETUP_TOKEN=...   # at least 32 characters
pnpm install --frozen-lockfile
pnpm deploy
```

To create resources without deploying:

```sh
pnpm cf:provision
pnpm db:migrate:remote
pnpm cf secret put SETUP_TOKEN
```

Keep R2 private. The hourly cron cleans expired auth artifacts, OAuth state, and unused media. No model-provider API key is required.

Custom domains are optional. After attaching one, set `PUBLIC_BASE_URL` to that origin and re-enroll passkeys if the hostname changed.

## Pull request checks

CI (`pnpm check`) already dry-runs the Worker bundle. The Deploy workflow repeats `pnpm build` on pull requests so the bundle is verified without uploading.

Live Workers Previews are not enabled. D1, KV, and R2 are not isolated per preview; sharing production fitness, OAuth, and media data would be unsafe. Add a dedicated preview database, bucket, and KV namespaces later if you want a persistent staging Worker (`wrangler deploy --env preview`).

## Native iOS client

`apps/ios` does not exist yet. When it is added, do not deploy it to Cloudflare. Give it a configurable API base URL (Xcode build setting, xcconfig, or Info.plist) and point that value at this Worker's `PUBLIC_BASE_URL`. Do not hard-code a workers.dev hostname in source.

## Swap to Vercel later

This is not a configuration-only switch today. Only the Cloudflare adapters and Worker entry are implemented.

To move the backend later without rewriting domain code:

1. Keep `FitnessService` and the shared operation registry as the application core.
2. Implement `Repository` (Postgres or another SQL store with the same transactional commit), `ObjectStore` (S3-compatible), `CacheStore` (Redis or Vercel KV), and `IdentityProvider`.
3. Add a Vercel/Node (or Vercel Fluid) entry that constructs those adapters, analogous to `src/index.ts` + `createCloudflarePlatform()`.
4. Replace `@cloudflare/workers-oauth-provider` with an OAuth stack that still serves MCP and REST from the same origin.
5. Map D1 numbered migrations to the new store. Do not rewrite historical plan, food, recipe, or meal snapshots.
6. Change the iOS API base URL (and MCP URL) to the new HTTPS origin. Re-enroll passkeys because the RP ID follows the hostname.

Until those adapters exist, production deploys stay on Cloudflare Workers.
