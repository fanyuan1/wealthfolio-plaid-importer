# 0042 — D41: Existing data

## Context
A moved database, a lost ledger, a relinked bank or an earlier CSV import no longer duplicates history (2026-11-07, redesigned 2026-11-07)

## Decision
**First push to an account** (the ledger has no row for it): after the securities are mapped, Sync lists every row Plaid would add, newest first, in New, Similar and Exact groups. New starts as Add; Similar and Exact start as Discard. The user decides per row or per selection (Add, Discard) and rows keep their place. Compare shows Plaid's version beside Wealthfolio's. A row Wealthfolio holds with our `plaid:<id>` note (whole word) is linked back as the importer's own without asking, on every push, so a restore without the ledger keeps Plaid's later changes flowing (2026-11-08). Exact: same day, ticker and amount; shares transferred in match any activity with the same shares that day. Similar: same day and amount, another type name. An opening position is compared with the sum of the account's earlier activities in that ticker: equal is Exact, different is Similar. There is no true-up of missing shares. Discarded rows are linked or recorded in the ledger as `adopted`, keep their category, and are not offered again. Nothing blocks Push; the header counts what will be added and discarded. **Later pushes:** rows already held under their `plaid:<id>` note are linked silently, not added again. Daily sync stops when the list has Similar or Exact rows The user's Add and Discard choices survive a replan.

## Consequences
None recorded beyond the decision.
