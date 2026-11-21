# 0052 — D51: Account refresh

## Context
New accounts at an institution show up without a button (2026-11-08)

## Decision
Accounts are read again after Connect and Reconnect, and when Accounts opens for each connection not checked in the last day. The automatic refresh never calls Identity, which Plaid bills per call; joint flags stay from the last call A manual refresh calls Identity only when the Item already has that product: calling it otherwise asks the bank for new consent. Accounts lists only the refresh lines with news: new accounts or a problem. A connection with nothing new is not listed.

## Consequences
None recorded beyond the decision.
