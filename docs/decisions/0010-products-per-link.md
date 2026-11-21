# 0010 — D8: Products per link

## Context
Optional products never fail Link; `auth` lets Chase offer "always" consent

## Decision
`transactions` required; `investments` and `auth` optional Plaid can list investment accounts on an Item that was linked without the investments product. Those accounts are skipped, with a log line.

## Consequences
None recorded beyond the decision.
