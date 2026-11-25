# 0063 — D62: Ratios and prices for old rows

## Context
A new ratio (D29) rewrote only the rows that Plaid still sends, about 24 months. Older rows kept the old ratio and the opening absorbed the difference. Openings without a Plaid cost take a Yahoo close for a day about two years back, which a later lookup may not return (2026-11-24).

## Decision
The ledger keeps, with each followed row, its Plaid security and the ratio used. A dry run converts a ledger row that Plaid no longer sends: quantity × new ratio ÷ old ratio, price × old ratio ÷ new ratio, amount unchanged. It goes through the same update path, so a row you edited stays (D61). A row pushed before this change has no ratio: when you accept a new ratio, the old one is remembered on the rows of that ticker, in the accounts that show the security. It is not guessed in an account where another security maps to the same ticker.

A failed Yahoo lookup no longer hides saved closes of past days. A new ratio is never proposed from them. An opening with no Plaid cost and no close keeps the price from the last push, before the Plaid price fallbacks. It is not scaled by the ratio, because a ticker's close does not depend on it.

## Consequences
A row that left Plaid's window before an earlier ratio change keeps that error. A row without a remembered ratio in a shared-ticker account stays unchanged once Plaid stops sending it. An opening whose old price was a Plaid price keeps it after a new ratio. A row you edited, and the other changes to its ticker, are listed as kept at each dry run.
