# 0045 — D44: Wiped account

## Context
After a wipe the ledger said everything was pushed and the cursor said nothing was new (2026-11-07)

## Decision
Each dry run counts the activities Wealthfolio holds for every synced account the ledger has rows for. At zero, the addon forgets the account's rows and its Item's cursor, so the next pull is a first pull and pushes everything again. An account with any activity is left alone; one that cannot be read is skipped. The cursor reset applies to the whole Item; its other accounts' rows stay in the ledger and are not pushed twice

## Consequences
None recorded beyond the decision.
