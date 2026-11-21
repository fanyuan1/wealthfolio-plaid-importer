# 0054 — D53: Account links

## Context
Two rows could pick the same account, and the second silently got a new one (2026-11-08)

## Decision
The selector and Create use one link plan: user picks first, then the closest names, in name order; a Wealthfolio account goes to one row only and leaves the other rows' lists. A linked row has Change until the first push to it, then shows a lock: moving pushed rows would mean deleting and importing them again. A Wealthfolio account the addon created stays after Change

## Consequences
None recorded beyond the decision.
