# 0031 — D29: Ratio updates

## Context
Price-only tickers drift from a fund that reinvests (2026-11-06)

## Decision
When Plaid's `institution_price` is newer than the stored ratio, the dry run proposes a new ratio from the ticker's close that day (no close yet: wait). The user confirms each one; the daily sync applies changes up to 5% and reports bigger ones A bigger jump is likely a bad price, not drift, so it waits for the user.

## Consequences
None recorded beyond the decision.
