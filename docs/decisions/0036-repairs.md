# 0036 — D35: Repairs

## Context
Fix a wrong mapping or a failed category push without losing data (2026-11-07)

## Decision
No delete or re-import action. Push fills in missing categories by itself: it re-pulls bank and card history only when pushed rows still lack a category

## Consequences
None recorded beyond the decision.
