# 0064 — D63: Plan contributions are external

## Context
Plaid reports a plan contribution as shares received, so it is pushed as a transfer in. Wealthfolio counts a transfer in as a net contribution only when `metadata.flow.is_external` is true. Without it, contributions can show as investment gains (2026-11-24).

## Decision
A security transfer in with the Plaid subtype `contribution` is created with that mark. The mark is set only on create. An update sends no metadata, and Wealthfolio keeps what the row has, so a mark you change stays.

## Consequences
Rows pushed before this change stay unmarked. Openings and other share transfers are not marked, because their source can be another tracked account. The ledger does not store the mark, so a row rebuilt only from the ledger, after you empty an account and Plaid no longer sends the row, is created without it.
