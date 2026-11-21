# 0034 — D32: Push through the addon SDK

## Context
Resolving a symbol per row was slow; cash rows have no symbol (2026-11-07). A duplicate flag on one VUSXX row failed every VUSXX row (2026-11-07)

## Decision
`checkImport` once per distinct security (only security rows; it requires a symbol), then `saveMany` creates in chunks of 500 with the resolved asset identity; updates and deletes in chunks of 100. Comments carry `plaid:<id>`. The check runs with `forceImport`, and only a problem with the security itself (symbol, asset, quote) fails its rows: its verdict on the one row it checked (a duplicate, a date) says nothing about the others. Every update carries the activity's currency, which `save_activities` requires. Rows Wealthfolio rejects keep its reason, appear in a dialog, and count against the daily sync. The ledger is saved even when a later step fails. While a push runs, a dialog shows its progress and asks the user to keep the window open Wealthfolio's server limit for one import is 1000 rows, so chunks stay well below it. Each failed row is reported as "date type symbol amount (plaid:id) — reason"; the failed-rows dialog parses this line.

## Consequences
None recorded beyond the decision.
