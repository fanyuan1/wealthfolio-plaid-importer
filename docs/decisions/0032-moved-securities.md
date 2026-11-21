# 0032 — D30: Moved securities

## Context
Wealthfolio cannot move an activity to another asset. An incremental pull would never reach older rows (2026-11-09)

## Decision
When a pushed security now maps to another symbol, to cash or to Leave out, the dry run blocks Push and offers to delete its pushed activities (two clicks); the next push imports them again as set now, from the account's full history, and rebuilds its opening rows. Saving a security records the change (`remap_<env>`), so rows outside the 14-day pull are caught too. A security that starts to be imported (from unmapped, cash or Leave out) gets the same full pull and rebuilt openings. The full pull repeats until a push saves every row

## Consequences
None recorded beyond the decision.
