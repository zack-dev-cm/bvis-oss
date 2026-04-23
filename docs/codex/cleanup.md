# Cleanup

## Keep Out Of Git

- `.env` files, bot tokens, service account keys, database URLs, and cookies.
- Playwright reports, videos, screenshots, and traces.
- Production project IDs, bot names, service names, secret names, and local paths.
- Generated media experiments unless intentionally selected for public fixtures.

## Cadence

Run cleanup before each release and after deployment, bot, or media-generation
changes. Re-run the public-surface audit after cleanup.
