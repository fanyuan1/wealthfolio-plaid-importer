# 0061 — D60: Test against the minimum and the newest Wealthfolio

## Context
The browser tests ran only against 3.12.0, the addon's minWealthfolioVersion, while users run the newest release. A 3.13 change to the host stylesheet broke the layout on phones, and the tests did not see it (2026-11-24). Testing only the newest release would leave minWealthfolioVersion an untested claim.

## Decision
The browser tests run once per Wealthfolio version: minWealthfolioVersion and the newest stable release. Each version is a Playwright project in playwright.config.ts, which passes it to test/docker/compose.yml as WF_VERSION. Each release's CHANGELOG section starts with "Tested with Wealthfolio" and names both versions.

## Consequences
The browser tests take twice as long. To move to a new Wealthfolio release, change NEWEST_WEALTHFOLIO in playwright.config.ts and the WF_VERSION default in test/docker/compose.yml. When minWealthfolioVersion in manifest.json changes, change MINIMUM_WEALTHFOLIO to match. Run one version with `pnpm test:e2e --project wealthfolio-3.13.1`.
