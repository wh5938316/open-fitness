# Contributing to OpenFitness

Use English for source identifiers, comments, documentation, diagnostics, and commit messages. Add user-facing text to both typed locale catalogs. Preserve user-authored Unicode data verbatim.

Use Node.js 24 LTS or newer and the pinned pnpm release. Run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm test:e2e` from the repository root before submitting changes. Browser tests require `pnpm browser:install` and use isolated local state. The server lives in `apps/server`; native applications will be independent projects under `apps/`.

Keep business rules in shared application operations so MCP and REST cannot drift. Add meaningful integration coverage for transactions, idempotency, authorization, snapshots, and storage changes. Run new schema changes through numbered D1 migrations; never rewrite an applied migration.

Do not commit credentials, health data, uploaded media, local storage, or browser traces. Example nutrition must be identified as illustrative. Keep model-provider integrations outside the server unless an explicit new feature requires them.

Follow [English Conventional Commit messages](docs/contributing/commit-messages.md). Explain behavioral changes, relevant tradeoffs, and actual validation in pull requests. The MIT license covers contributions to project code; retain provenance for third-party data.
