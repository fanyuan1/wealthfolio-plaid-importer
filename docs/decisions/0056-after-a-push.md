# 0056 — D55: After a push

## Context
Closing the failed-rows dialog wiped the screen, and the next dry run pulled everything again (2026-11-08)

## Decision
The push plans again from the same Plaid pull against the saved ledger, so the screen keeps the securities and shows what is left: rows Wealthfolio refused come back as new, and their securities move to Needs attention with Wealthfolio's reason. A dry run reuses a pull of the same connections, accounts and followed funds for 15 minutes; Pull fresh from Plaid forces a new one, and the daily sync always pulls

## Consequences
None recorded beyond the decision.
