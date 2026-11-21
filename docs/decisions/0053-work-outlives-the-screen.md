# 0053 — D52: Work outlives the screen

## Context
Switching steps lost a running sync's progress (2026-11-08)

## Decision
Dry run, push, Update preview, deleting a moved ticker, the daily sync (also when the timer starts it), the account refresh, creating accounts and restore run as engine tasks. A task keeps its progress, log, result and error until the next run of the same kind, so leaving a step and coming back shows where it is. The Sync view lives in the engine for the same reason A selector passed to the engine hook must return a kept object, not a new one, or the screen re-renders on every change.

## Consequences
None recorded beyond the decision.
