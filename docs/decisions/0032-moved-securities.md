# 0032 — D30: Moved securities

## Context
Wealthfolio cannot move an activity to another asset. An incremental pull would never reach older rows (2026-11-09)

## Decision
When a pushed security now maps to another symbol, to cash or to Leave out, the dry run blocks Push and offers to delete its pushed activities (two clicks); the next push imports them again as set now, from the account's full history, and rebuilds its opening rows. Saving a security records the change (`remap_<env>`), so rows outside the 14-day pull are caught too. A security that starts to be imported (from unmapped, cash or Leave out) gets the same full pull and rebuilt openings. The full pull repeats until a push saves every row Recording a change needs a pull that saw the security: without one, nothing was pushed for it yet. Mapping a security back to the symbol its rows already use clears its moved flag. When a fund's older buys are imported later, the opening cash grows by what they spent, since that cash must have been there.

## Consequences
None recorded beyond the decision.
