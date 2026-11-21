# 0017 — D15: History

## Context
Plaid's investments limit; late and corrected rows are caught

## Decision
About 24 months on the first pull (729 days), then incremental: investments re-pull 14 days, transactions use the `/transactions/sync` cursor. Pending transactions are never imported

## Consequences
None recorded beyond the decision.
