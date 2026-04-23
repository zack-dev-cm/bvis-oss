# Security Policy

## Supported Versions

Security fixes land on `main` first.

## Reporting a Vulnerability

Do not open public issues for credential exposure, bot-token misuse, account
takeover, webhook bypasses, or Telegram `initData` validation bugs. Send a
private report to the repository owner with reproduction steps, affected commit
or deployment URL, and redacted logs or screenshots.

## Credential Handling

Never commit Telegram bot tokens, service account keys, database URLs, session
cookies, production `.env` files, or generated webhook secrets. If a secret is
committed or shared publicly, rotate it at the provider before redeploying.
