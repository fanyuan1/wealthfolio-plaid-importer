# 0049 — D48: Progress, no log

## Context
The log mixed actions, progress and debug text, and the user could not tell what to do with it (2026-11-08)

## Decision
The engine reports progress as events (one line per connection, its bank and investment pulls nested below, then one line per push stage). Sync shows them in a list that scrolls after a few lines. Every result that needs the user is an alert or a to-do card with a button to where it is fixed. The raw log is kept only in memory; it is not shown

## Consequences
None recorded beyond the decision.
