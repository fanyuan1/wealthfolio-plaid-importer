# 0023 — D21: Corrections

## Context
Wealthfolio's Spending counts VOID rows with their category (2026-11-07)

## Decision
Plaid edits update the Wealthfolio activity. Plaid removals, and rows the mapping now drops, are deleted; the ledger keeps them voided so they never come back. Linked transfer legs are voided

## Consequences
None recorded beyond the decision.
