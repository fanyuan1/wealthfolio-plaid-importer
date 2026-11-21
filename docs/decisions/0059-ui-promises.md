# 0059 — D58: Promises in the UI

## Context
lints v0.4.1 flags promises that nobody handles. Some screen loads had no catch, so a failed read left a blank or stale screen with no message (2026-11-21)

## Decision
Every promise a screen starts ends in its error display. `run` (useBusy) catches every error and shows it in the screen's Problem alert. `save` (useSave) catches every error and shows a toast (D49). `start` (useTask) catches every error; the task keeps it and the screen shows it in Problem (D52). These three never reject, so callers mark them with `void`. A screen's load on mount reports a failure with useBusy's `fail`, which shows it in that screen's Problem alert. The page shows a failed start as a Problem alert instead of a blank page, and a failed refresh of the step marks as a toast. No promise gets an empty catch.

## Consequences
A new helper that returns a promise must either catch everything, so callers can use `void`, or let callers route the rejection to the screen's error display. The browser tests in test/e2e/load-errors.spec.ts fail reads and check that the screen shows the Problem alert.
