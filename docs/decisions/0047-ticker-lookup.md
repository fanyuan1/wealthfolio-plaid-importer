# 0047 — D46: Ticker lookup

## Context
The user must choose a setting Wealthfolio accepts (2026-11-07)

## Decision
Wealthfolio's own ticker search, exact match on symbol, canonical symbol or provider symbol. A Yahoo-close test was tried (SCBP1, BRK-B) and removed, because Wealthfolio's answer is the one that decides whether an asset can be created, and the user can pick from its suggestions

## Consequences
None recorded beyond the decision.
