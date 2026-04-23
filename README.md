# Beauty Visual Inbox

Beauty Visual Inbox is a Telegram Mini App plus bot backend for beauty studios.
Clients submit photos through a Telegram bot, admins review and publish batches,
and clients browse a vertical mini-app feed with Telegram-authenticated likes.

## Stack

- Backend and bots: Node 20, Express, Telegraf, Prisma, PostgreSQL, Pino.
- Mini app: Vite, React, TypeScript, Telegram WebApp SDK.
- Tests: Playwright for mini-app flows, Vitest/Supertest for API behavior.
- Deployment: Docker-ready app with optional Cloud Run workflow.

## Local Development

```bash
npm install
npm run dev --workspace mini-app
USE_POLLING=true npm run dev --workspace api
```

In development, the mini-app proxy sends `/api` and `/mock-media` requests to a
local API port. Override it with `VITE_API_PROXY_TARGET` if your API runs
elsewhere.

Common API environment variables:

- `DATABASE_URL`: PostgreSQL connection string.
- `ADMIN_BOT_TOKEN`: Telegram token for the admin bot.
- `CLIENT_BOT_TOKEN`: optional bootstrap token for the first client bot.
- `CLIENT_BOTS_JSON`: optional list of client bots to import on startup.
- `WEB_APP_BASE_URL`: public mini-app URL used in Telegram buttons.
- `WEBHOOK_BASE_URL`: public webhook URL when polling is disabled.
- `ADMIN_WEBHOOK_SECRET` and `CLIENT_WEBHOOK_SECRET`: webhook route secrets.
- `USE_POLLING`: `true` for local polling, `false` for webhooks.
- `USE_MOCK_MEDIA_FEED`: `true` to serve demo media without a database.
- `GOOGLE_API_KEY`: optional image-generation key for admin tooling.
- `ENCRYPTION_KEY`: required in production to encrypt stored client bot tokens.
- `SKIP_BOT_BOOTSTRAP` and `SKIP_NOTIFICATION_DISPATCHER`: useful for tests.

Never commit production `.env` files, bot tokens, database URLs, service account
keys, or generated credentials.

## Checks

```bash
npm ci --workspaces
npm run lint
npm run build
npm run test:e2e
npm audit --audit-level=high
```

API integration tests use Testcontainers and require a local Docker daemon:

```bash
npm run test --workspace api
```

## Telegram Mini App Auth

Client actions that mutate state require Telegram `initData`. The mini app sends
it to the API through request bodies or `X-Telegram-Init-Data`, and the backend
validates the Telegram hash against configured bot tokens before accepting likes,
visits, or admin-only state.

Open the app from Telegram for production flows. Browser-only development can use
mock media and Playwright stubs, but production deployments must validate real
Telegram `initData`.

## Deployment

This public export includes CI only. Add deployment automation in your own
environment-specific workflow and provide runtime secrets through your
deployment platform or secret manager:

- `DATABASE_URL`
- `ADMIN_BOT_TOKEN`
- `CLIENT_BOT_TOKEN` or `CLIENT_BOTS_JSON`
- `ENCRYPTION_KEY`
- `GOOGLE_API_KEY` if the generation feature is enabled
- webhook secrets and public base URLs

For manual deployment, build the Docker image and inject environment variables
from your deployment environment. Do not bake secrets into the image.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting and credential
handling.

## Repository Map

- `apps/mini-app/`: Telegram WebApp frontend.
- `apps/api/`: Express API, Telegram bots, Prisma schema, and migrations.
- `tests/e2e/`: Playwright mini-app coverage.
- `.github/workflows/`: CI and release-gate workflows.
- `docs/codex/`: durable release, architecture, and verification notes.
