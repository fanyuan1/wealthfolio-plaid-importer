# 0026 — D24: Transfers

## Context
Unlinked transfers count as spending (2026-11-07)

## Decision
Legs across linked accounts are paired within 3 days, same amount and currency, both with Plaid's transfer or card-payment category, and linked in Wealthfolio. Legs that share a reference number (6+ digits, e.g. Chase `transaction#`) pair first

## Consequences
None recorded beyond the decision.
