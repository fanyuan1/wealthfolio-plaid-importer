# 0020 — D18: Opening positions

## Context
Older positions would go negative; Plaid has cost basis only for current holdings; VGT openings priced 8× too low (2026-11-07)

## Decision
TRANSFER_IN at the window start = holdings − pulled net change, at Plaid's cost basis. Without a cost basis: the Yahoo Finance close that day (cached; the last close within 7 days), else the earliest Plaid price. Each one goes to the to-do report. After a later split the price is multiplied by the split factor (D45): cost basis and Yahoo closes count today's shares, the opening quantity counts the shares of that day Yahoo Finance is Wealthfolio's default price provider. An account gets an opening position, and a full history pull, while the ledger holds no rows for it. A saved sync date alone does not count: a push can record that date without saving any rows (2026-11-21). The opening is computed again from the holdings and every known row when the pull is a full one (a remapped or tracked security) or brings a new row dated before the last sync: Plaid can update holdings days before it reports the trade, so the first opening may already hold those shares. The ledger keeps which accounts have had a full-history pull pushed (`invFull`); an account without it gets one full pull and a new opening, which repairs accounts whose first pull was only recent.

## Consequences
None recorded beyond the decision.
