# 0061 — D60: Test against the newest Wealthfolio

## Context
The browser tests ran against 3.12.0, the addon's minWealthfolioVersion, while users run the newest release. A 3.13 change to the host stylesheet broke the layout on phones, and the tests did not see it (2026-11-24).

## Decision
The browser tests run against the newest Wealthfolio release. Each release's CHANGELOG section starts with "Tested with Wealthfolio X.Y.Z" and names that version. minWealthfolioVersion stays at the oldest version the addon is believed to work with, and is raised when the addon uses something newer.

## Consequences
The minimum version is no longer tested on each release. To bump Wealthfolio, change the image tag in test/docker/compose.yml and run `pnpm test:e2e`.
