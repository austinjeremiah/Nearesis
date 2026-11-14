# Nearesis frontend

Next 16 app. Talks to the Nearesis kernel API only through its own same-origin BFF (`app/api/**`); the browser never sees the API origin or the session token.

## Run against the backend

```bash
corepack pnpm install
NEARESIS_DEV_LOGIN=1 NEARESIS_API_URL=http://127.0.0.1:4110 corepack pnpm dev -p 3400
```

- `NEARESIS_API_URL` (server only, default `http://127.0.0.1:4110`)
- `NEARESIS_DEV_LOGIN=1` enables the dev sign-in on `/login` (never in a production build unless `NEARESIS_TEST_HOOKS=1`)
- `NEARESIS_OIDC=1` enables single sign-on: `/api/auth/oidc/start` and the registered redirect URI `/api/auth/oidc/callback` (state bound to the browser by an HttpOnly cookie; the API answers 404 OIDC_NOT_CONFIGURED until a provider is configured)

## Tests

```bash
corepack pnpm typecheck && corepack pnpm test      # unit tests
corepack pnpm test:e2e                             # Playwright smoke against the real API + this app on :3400
corepack pnpm gen:contracts                        # regenerate lib/contracts/generated from the backend docs/api
```

`gen:contracts` reads `../../nearesis-app/docs/api` (override with `NEARESIS_API_DOCS`). The generated files are committed.
