# 0051 — D50: Initials

## Context
A typo at Connect otherwise costs removing the connection and adding its token again (2026-11-08)

## Decision
The initials of a connection can be changed in Connections. The change renames only accounts not yet created in Wealthfolio; activities point to accounts by id and do not change The field saves when it loses focus or on Enter. An Enter that confirms IME composition is ignored (keyCode 229 covers Safari's out-of-order isComposing).

## Consequences
None recorded beyond the decision.
