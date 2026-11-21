# 0022 — D20: Cash sweep

## Context
Avoids double-counted cash

## Decision
`is_cash_equivalent` or `type: cash` is cash, and its buys and sells are dropped. Merrill's bank sweep (type other, ticker "Deposit") too

## Consequences
None recorded beyond the decision.
