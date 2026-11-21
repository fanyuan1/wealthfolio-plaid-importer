# 0052 — D51: Account refresh

## Context
New accounts at an institution show up without a button (2026-11-08)

## Decision
Accounts are read again after Connect and Reconnect, and when Accounts opens for each connection not checked in the last day. The automatic refresh never calls Identity, which Plaid bills per call; joint flags stay from the last call

## Consequences
None recorded beyond the decision.
