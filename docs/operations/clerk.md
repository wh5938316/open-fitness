# Clerk sign-in

Clerk is the identity provider for new sign-ins. OpenFitness still issues its own
`__Host-of_session` cookie after a one-time token exchange. Clerk session JWTs are
not accepted as API or MCP bearer tokens.

Use a Clerk **development** instance for local and `workers.dev` work. A production
Clerk instance needs a `clerk.<your-domain>` CNAME, and `*.workers.dev` cannot host
that record. Production custom domains are an operations follow-up.

## Dashboard

- Enable email code and passkeys. Email link is optional and needs a device check
  inside `ASWebAuthenticationSession`.
- Keep user registration **Restricted** until auto-provisioning is turned on.
- Leave `CLERK_AUTO_PROVISION=false` until that change ships. An unknown Clerk user
  is rejected with `ACCOUNT_NOT_PROVISIONED`.

## Worker configuration

Put these in `apps/server/.dev.vars` for local development. Do not commit real values.

| Name                    | Kind   | Purpose                                                               |
| ----------------------- | ------ | --------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY` | public | Browser Clerk.js key                                                  |
| `CLERK_FRONTEND_API`    | public | Frontend API origin, for example `https://example.clerk.accounts.dev` |
| `CLERK_JWT_KEY`         | secret | PEM public key from Dashboard → API keys → JWT public key             |
| `CLERK_SECRET_KEY`      | secret | Backend API. Used only when creating an OpenFitness account           |
| `CLERK_AUTO_PROVISION`  | var    | `false` until per-user provisioning is enabled                        |

`CLERK_JWT_KEY` makes session-token checks offline. Do not rely on a secret-key JWKS fetch.

## Bind the existing owner

The migrated row stays `id='owner'`. Nothing in the app writes `clerk_user_id` for that
row. After you create your Clerk user, bind it yourself.

Local only, from `apps/server`:

```sh
pnpm exec wrangler d1 execute DB --local --command \
  "UPDATE owners SET clerk_user_id='user_xxx', email='me@example.com' WHERE id='owner' AND clerk_user_id IS NULL;"
```

A remote bind is the same statement with `--remote`. Run it only as a deliberate
production change. Do not run it as part of routine local verification, tests, or
deploys from this repository.

Until that update is applied, Clerk sign-in cannot open the existing owner's data.
The legacy passkey still can.
