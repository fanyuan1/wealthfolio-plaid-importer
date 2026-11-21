# 0012 — D10: Existing connections

## Context
Moving to another device must not use new Plaid connections. A ledger restored into other Wealthfolio data would block rows the user deleted from being pushed again; rows with the importer's `plaid:<id>` note are linked back on the first push (D41), so a restore without it loses only the incremental pull (2026-11-08)

## Decision
Connections takes one access token (Plaid returns the institution, products and accounts; the user types only the initials). Backup (step 6) makes a **connections backup** (connections and their tokens only; Accounts reads their accounts again after a restore) or a **full backup** (also account selections, securities settings, pending securities changes (D30) and the ledger), as `plaid-importer-backup` with a `kind`. Save as file uses Wealthfolio's file save (`files.openSaveDialog`), which works on every surface; a plain browser download does not reach the user in the app. The full backup is the recommended one: it also keeps the user's Discard decisions, which a connections backup would ask for again. Restore asks first. **Restore** merges: what is already there wins. **Overwrite** (a second confirmation lists what it removes) replaces what the backup holds; connections the backup lacks are removed with their tokens and accounts; activities in Wealthfolio are not touched. A full backup whose Wealthfolio accounts are all missing here restores without the ledger and pending changes. Version 0.1.0 starts this format; later versions keep reading it The save dialog returns only whether it saved, not the name the user chose.

## Consequences
None recorded beyond the decision.
