# 0062 — D61: Recalculated openings

## Context
A mapping fix changed a pushed buy from 0.5 to 2 shares. The opening of 1.5 shares stayed, because a changed row did not recalculate openings, and an opening that became zero produced nothing (2026-11-24).

## Decision
An investment account recalculates its openings when a pushed row now changes its shares or cash. Only openings of the changed tickers and opening cash are touched, and only when shares or cash change, so cost basis stays and other differences stay in the holdings check. An opening that becomes zero is voided. A voided opening is created again when it is needed. If an edit or old data (D43) blocks a trade or an opening, the other changes to that ticker are dropped too, and the cash opening stays when a blocked row moves cash. A row you edited that already matches the change is recorded in the ledger with no write. A removal of a row you already deleted is recorded with no write. The holdings check runs again on the changes that remain.

Wealthfolio flags every update as user modified, the importer's own included, so the flag alone let an opening change only once. A flagged row counts as yours only when it differs from what the importer last wrote (type, date, ticker, quantity, price, amount, fee, currency) or is void. A trade without a written amount matches quantity × price with the fee. This replaces the flag rule in D43. An update sends the row's current notes, because Wealthfolio clears notes that an update leaves out (2026-11-24).

## Consequences
A push can delete an opening. The dry run shows it. A change to only the notes, tax, subtype or transfer link is not seen as an edit: an update keeps the notes, but a removal deletes the row. An option trade whose amount Wealthfolio multiplied by the contract size counts as yours. Notes cleared by earlier updates stay empty. Bank and card openings are calculated once and do not change. A cancelled or removed trade does not recalculate openings. An opening that was already stale before this change, with its trade already updated, stays until the account is pulled in full.
