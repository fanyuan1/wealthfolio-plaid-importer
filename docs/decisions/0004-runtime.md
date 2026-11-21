# 0004 — D2: Runtime

## Context
Runs inside the app; the core is testable without the app (2026-11-07)

## Decision
A Wealthfolio addon on a pure TypeScript importer (`src/importer/`): mapping, planner, push, Plaid client, prices and naming, with tests plan() is synchronous and pure, so prices are fetched first: plan once to learn which closes it asks for, fetch them, then plan again with the cache filled.

## Consequences
None recorded beyond the decision.
