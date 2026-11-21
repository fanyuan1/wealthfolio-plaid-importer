# 0037 — D36: Reconnect

## Context
No webhook: the addon has no public server. An early warning on every pull added noise for something a failed pull already says (2026-11-08)

## Decision
Each pull checks Item health; a blocked Item is skipped with a Reconnect button to Connections, and the others sync. No warning before a bank's consent ends: the user reconnects when a pull fails

## Consequences
None recorded beyond the decision.
