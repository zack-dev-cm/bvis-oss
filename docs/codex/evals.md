# Evals

## Automated Checks

- Lint: `npm run lint`
- Build: `npm run build`
- Mini-app smoke: `npm run test:e2e`
- Dependency audit: `npm audit --audit-level=high`
- Public-surface audit: `python3 -m codex_harness audit . --strict --min-score 90`

## Manual Checks

- Open the mini app from Telegram and confirm real `initData` is present.
- Verify likes and visits reject missing or invalid `initData`.
- Verify webhooks use non-default secrets in deployed environments.
- Confirm runtime secrets are configured outside the repository.
