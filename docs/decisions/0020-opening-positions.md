# 0020 — D18: Opening positions

## Context
Older positions would go negative; Plaid has cost basis only for current holdings; VGT openings priced 8× too low (2026-11-07)

## Decision
TRANSFER_IN at the window start = holdings − pulled net change, at Plaid's cost basis. Without a cost basis: the Yahoo Finance close that day (cached; the last close within 7 days), else the earliest Plaid price. Each one goes to the to-do report. After a later split the price is multiplied by the split factor (D45): cost basis and Yahoo closes count today's shares, the opening quantity counts the shares of that day Yahoo Finance is Wealthfolio's default price provider.

## Consequences
None recorded beyond the decision.
