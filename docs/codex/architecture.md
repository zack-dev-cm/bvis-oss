# Architecture

## Components

- `apps/mini-app`: React UI that reads Telegram WebApp context and calls the API.
- `apps/api`: Express routes, Telegraf bot flows, Prisma access, and media proxying.
- `tests/e2e`: Playwright tests with Telegram and API stubs.

## Trust Boundaries

- Browser state is untrusted until Telegram `initData` is validated by the API.
- Bot tokens, database URLs, and webhook secrets must come from the runtime
  environment or secret manager.
- Media proxy routes must never expose bot tokens to the client.
- Local mock media and Playwright stubs are development-only.
