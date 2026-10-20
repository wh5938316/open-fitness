# Contributor instructions

Use English for code, comments, documentation, commit messages, logs, and developer diagnostics. Localize user-facing messages through the typed `en` and `zh-CN` dictionaries. Preserve user-authored names and notes verbatim. Communicate with contributors in their preferred language.

This is a lightweight monorepo. The Cloudflare server lives in `apps/server`; future native clients belong under `apps/`. Do not create shared packages until there is a concrete second consumer. Keep repository-wide scripts and CI at the root.

Keep MCP and REST behavior in the same application operation registry. Put persistent business access behind `Repository`, files behind `ObjectStore`, external caches behind `CacheStore`, and identity verification behind `IdentityProvider`. Cloudflare is the first implementation; do not imply that an unimplemented deployment adapter already works.

Writes need stable operation IDs and version checks. Commit business changes, revisions, references, and Apple Health export events atomically. Never rewrite historical plan, food, recipe, or meal snapshots when editing templates. Unknown nutrients stay unknown; require explicit unit conversion information and estimate provenance.

Run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm test:e2e` from the root. Browser acceptance needs `pnpm browser:install`. Add meaningful coverage when behavior changes. Do not commit local credentials, databases, health data, uploads, generated assets, or traces.

Use numbered migrations for schema changes. Follow [commit message conventions](docs/contributing/commit-messages.md). Do not deploy or mutate remote data as part of routine local verification.
