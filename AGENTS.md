# AGENTS.md

Use this as a short index for repository-local automation. Keep durable details
in `docs/codex/`.

## Repo Map

- `apps/mini-app/`: Vite/React Telegram Mini App.
- `apps/api/`: Express API, Telegram bot handlers, Prisma schema, migrations,
  and tests.
- `tests/e2e/`: Playwright mini-app tests and Telegram stubs.
- `.codex/agents/`: project-scoped review roles.
- `docs/codex/`: architecture, workflow, eval, and cleanup notes.

## Default Verification

1. `npm run lint`
2. `npm run build`
3. `npm run test:e2e`
4. `npm audit --audit-level=high`
5. `python3 -m codex_harness audit . --strict --min-score 90`

## Public-Surface Rules

- Do not commit `.env` files, bot tokens, service account keys, database URLs,
  local paths, or production deployment identifiers.
- Use placeholders for project IDs, bot names, URLs, and secret names in docs.
- Keep Telegram `initData` validation enforced outside local test stubs.
