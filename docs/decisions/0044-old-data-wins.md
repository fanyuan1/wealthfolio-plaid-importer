# 0044 — D43: Old data wins

## Context
Explicit consent only: the user edits or deletes the row in Wealthfolio (2026-11-07)

## Decision
The importer never changes or deletes an activity it did not create or that the user edited: rows linked from existing data are marked `adopted` in the ledger, and activities Wealthfolio flags as user-modified count the same. Plaid changes, removals, transfer retypes and transfer links for them are dropped from the plan and listed under "Kept as they are in Wealthfolio". Repairs (retrack) skip adopted rows. A restore replaces what is already stored only when the user picks Overwrite and confirms it

## Consequences
None recorded beyond the decision.
