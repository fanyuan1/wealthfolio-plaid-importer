# 0041 — D40: Testing

## Context
Real links cost permanent Plaid connections

## Decision
vitest on recorded payloads and fakes of Wealthfolio and its storage limit → Plaid Sandbox in a separate Wealthfolio profile → real links Browser tests run with `pnpm test:e2e` and are skipped without a running Docker. They use one Wealthfolio container, reset for each test, so they run on one worker. Browser tests: Wealthfolio's server calls only public HTTPS hosts, so the fake Plaid sits behind no URL; the tests answer the addon's network calls (POST /api/v1/addons/<id>/network/request) with it. The test Wealthfolio turns off its update check, because an older pinned image would open a "New Update Available" popup over every page. A layout test checks every class under src/ui, because the addon gets only the Tailwind classes Wealthfolio itself uses, and it must fit a phone.

## Consequences
None recorded beyond the decision.
