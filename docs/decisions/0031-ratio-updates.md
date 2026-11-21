# 0031 — D29: Ratio updates

## Context
Price-only tickers drift from a fund that reinvests (2026-11-06)

## Decision
When Plaid's `institution_price` is newer than the stored ratio, the dry run first fetches the ticker's newest closes, then proposes a new ratio from the latest close in the 7 days up to that day (Plaid dates prices on weekends and holidays). It does not ask again when the fund's price equals the stored one. The user confirms each one; the daily sync applies changes up to 5% and reports bigger ones A bigger jump is likely a bad price, not drift, so it waits for the user.

## Consequences
None recorded beyond the decision.
