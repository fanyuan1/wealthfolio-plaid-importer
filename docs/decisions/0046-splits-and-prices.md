# 0046 — D45: Splits and prices

## Context
VGT's 8-for-1 split priced Chase and Schwab openings at $44 instead of $350 and the return looked huge; a Schwab transfer carried an adjusted price on an old quantity (2026-11-07)

## Decision
A security's SPLIT ratio comes from the position before it (D22). Opening prices from cost basis, from a Yahoo close and from today's price are multiplied by the product of the splits after the opening, because those prices count today's shares and the opening quantity counts the shares of its day. Plaid sometimes prices a trade from before a split in today's shares: for a buy, sell or transfer before a later split of 1.5× or more, a price within 30% of Yahoo's (split-adjusted) close, and not within 30% of the close times the splits, is multiplied by them. Each correction is a to-do item with both prices. Rows with a market price, opening rows and smaller splits are skipped

## Consequences
None recorded beyond the decision.
