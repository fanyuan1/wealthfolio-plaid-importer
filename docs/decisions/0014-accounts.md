# 0014 — D12: Accounts

## Context
Share every account in Link; choosing later is one switch

## Decision
Every shared account is listed, off by default; Select all turns on every supported one. Each selected row has a **Previous account** list: the Wealthfolio accounts of the same type that no other row uses, with the closest name (or a shared account number) preselected, or **New**. Created and Spend tracking show the state of the account the row will use. The button creates the New ones and links the rest (2026-11-07). New accounts are created with `trackingMode: TRANSACTIONS`. Loans and mortgages are not supported A depository account that holds securities in Plaid's holdings (a brokerage cash-management account, such as Merrill CMA-Edge) is treated as an investment account.

## Consequences
None recorded beyond the decision.
