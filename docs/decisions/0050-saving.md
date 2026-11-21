# 0050 — D49: Saving

## Context
Every change is one control, so a Save button would add only unsaved-change handling (2026-11-08)

## Decision
Toggles, picks, initials and the daily sync time save on change. The control shows it: it fades into a green ✓ for a moment, in its own space. A failed save is a toast. Only Save keys (it checks the keys with Plaid) and the security editor's Save (it turns off Push until Update preview) are buttons

## Consequences
None recorded beyond the decision.
