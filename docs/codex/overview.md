# Overview

Beauty Visual Inbox is a Telegram Mini App and bot backend for beauty studios.
It supports admin-managed photo batches, client submissions, and
Telegram-authenticated mini-app likes.

## Landmarks

- Frontend: `apps/mini-app/`
- Backend and bots: `apps/api/`
- E2E tests: `tests/e2e/`
- Deployment: `Dockerfile` and `.github/workflows/`
- Public metadata: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`

## Standard Checks

- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm audit --audit-level=high`
- `python3 -m codex_harness audit . --strict --min-score 90`
