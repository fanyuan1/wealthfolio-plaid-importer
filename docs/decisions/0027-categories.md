# 0027 — D25: Categories

## Context
Plaid first, the user wins after; one bad row must not leave the rest uncategorized

## Decision
Plaid's personal finance category → a Wealthfolio Spending category, set once after import, so the user's changes stay. Current income keys: `INCOME_SALARY`/`INCOME_WAGES` → income_salary, `INCOME_CONTRACTOR` → income_freelance. A failed batch is retried one row at a time. The ledger keeps Plaid's category with each row, so rows left without one (a failed batch, an update) get it after the next push with no Plaid call; rows from before that are pulled once A connection that could not be pulled keeps its rows without a stored category, so the next push tries again. Detailed matches win over primary ones. A subcategory key Wealthfolio lacks falls back to its parent key. An inflow on a spending category (a refund, for example) is left uncategorized, for Wealthfolio's rules.

## Consequences
None recorded beyond the decision.
