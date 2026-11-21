# 0005 — D3: Money

## Context
Exact decimal math; rounding noise is never an update

## Decision
big.js with 28 decimal places and half-even rounding; ledger values compare at 8 decimal places The importer uses its own big.js constructor, so its settings never leak to other users of big.js. JS numbers are never used for money: 0.1 + 0.2 !== 0.3 breaks amount matching.

## Consequences
None recorded beyond the decision.
