# 0006 — D4: Secrets

## Context
Tokens never land in Wealthfolio's database or synced storage

## Decision
Plaid client ID and secret, and each access token, in addon secrets through the addon SDK (Wealthfolio's secret store; never synced). Everything else in addon storage, per Plaid environment

## Consequences
None recorded beyond the decision.
