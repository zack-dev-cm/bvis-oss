# Contributing

## Local Checks

Run these before opening a pull request:

```bash
npm ci --workspaces
npm run lint
npm run build
npm run test:e2e
npm audit --audit-level=high
```

API integration tests require Docker:

```bash
npm run test --workspace api
```

## Pull Request Expectations

- Do not commit `.env` files, bot tokens, service account keys, database URLs,
  cookies, local paths, generated Playwright reports, or production deployment
  identifiers.
- Use placeholders for project IDs, bot names, service names, and public URLs in
  docs and examples.
- Include a verification note for UI, Telegram auth, bot, or deployment changes.
