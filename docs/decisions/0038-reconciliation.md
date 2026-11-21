# 0038 — D37: Reconciliation

## Context
Some institutions' investment transactions are unreliable

## Decision
Plaid holdings vs ledger positions each pull; differences go to the to-do report An account that Plaid reports with a balance only (for example a brokerage window) holds hand-entered positions. There is nothing to check them against, so it gets no to-do for "holdings 0" or a negative opening position.

## Consequences
None recorded beyond the decision.
