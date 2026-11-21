# 0033 — D31: Dry run, then push

## Context
The push matches what the user saw (2026-11-07)

## Decision
Dry run pulls from Plaid and plans; Push sends exactly that plan. After a securities change, Push is off until Update preview re-plans from the same pull (no new Plaid call). A fund newly set to Follow ticker needs a new dry run for its full history

## Consequences
None recorded beyond the decision.
