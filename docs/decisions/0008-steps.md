# 0008 — D6: Steps

## Context
A first-time user follows the order; a returning user wants Sync

## Decision
A stepper 1. Setup → 2. Connections → 3. Accounts → 4. Sync → 5. Daily sync → 6. Backup. Done steps show ✓; Sync and Daily sync show a lock with the reason until every selected account is linked; Backup is never locked, so a restore works on a new device. Each step has short directions. There are no Next buttons: the ✓ marks show what is done (2026-11-08). Leaving Accounts by any step warns when spending is off for a synced bank or card account (D42). The addon opens on Setup until a push has worked, then on Sync

## Consequences
None recorded beyond the decision.
