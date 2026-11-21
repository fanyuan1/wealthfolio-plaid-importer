# 0043 — D42: Spending flag

## Context
Spending is a Wealthfolio setting (2026-11-07)

## Decision
Accounts shows whether Spending is on for each bank and card account, read from Wealthfolio, also for the existing account a row will link to. The addon SDK cannot turn it on (its spending API is read-only). Leaving Accounts for any other step with spending off for a synced bank or card account opens a dialog: Stay here, or Continue anyway. Leaving the addon through Wealthfolio's sidebar cannot be caught. Rows pushed without it have no category; each push finds rows with none and sets them once spending is on (D35)

## Consequences
None recorded beyond the decision.
