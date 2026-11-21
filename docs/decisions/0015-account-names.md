# 0015 — D13: Account names

## Context
Sandbox names passed 50 characters; generated abbreviations looked odd (2026-11-05)

## Decision
`AB · InstShort PlaidName ••mask`, at most 50 characters (Wealthfolio's form limit). InstShort comes from `src/importer/abbreviations.json` (longest prefix match), else Plaid's name. The word "Plaid" is removed. When too long, the institution is trimmed first (to at least 12 characters), then the account name, with …; duplicates get (n)

## Consequences
None recorded beyond the decision.
