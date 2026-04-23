# Workflow

## Development

1. Install dependencies with `npm ci --workspaces`.
2. Run the mini app with `npm run dev --workspace mini-app`.
3. Run the API with `npm run dev --workspace api`.

## Review

Before opening a pull request:

1. Run `npm run lint`.
2. Run `npm run build`.
3. Run `npm run test:e2e`.
4. Run `npm audit --audit-level=high`.
5. Run `python3 -m codex_harness audit . --strict --min-score 90`.

## Release

Release only from tracked, reviewed state. Public docs must use placeholders for
bot names, project IDs, service names, and deployment URLs.
