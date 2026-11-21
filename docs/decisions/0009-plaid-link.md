# 0009 — D7: Plaid Link

## Context
Wealthfolio's addon frame blocks `window.open` and Link's iframe

## Decision
Hosted Link. The addon shows the link with Copy (an addon cannot open a browser), then asks `/link/token/get` every 3 seconds for up to 30 minutes and shows the result: connected, or the reason the login did not finish. Reconnect works the same way and exchanges no token. Sandbox also offers a test bank with no login Copy falls back to selecting the link's text when the addon frame has no clipboard access. A finished login is never exchanged twice. A failed check is retried on the next tick.

## Consequences
None recorded beyond the decision.
