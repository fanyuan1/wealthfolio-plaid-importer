# Changelog

Versions follow [semantic versioning](https://semver.org).

## 0.1.1 - 2026-11-11

Works with Wealthfolio 3.13, and still with 3.12.

### Fixed

- The Copy button on Backup and the "rows were not saved" popup on Sync use layout classes that Wealthfolio 3.13 still has. With 0.1.0 on 3.13, the Copy button could be narrower and the popup had no height limit of its own.

## 0.1.0 - 2026-11-09

First release.

### Capabilities

- Six steps: Setup, Connections, Accounts, Sync, Daily sync and Backup. Done steps show ✓; Sync and Daily sync unlock when every selected account exists in Wealthfolio.
- Connects through Plaid Hosted Link and notices by itself when the login finishes. Reconnect uses the same connection. A connection whose login expired shows Reconnect needed.
- Initials name each owner's accounts and can be changed later. New accounts at an institution show up without a button.
- Imports transactions, trades, dividends and holdings from Plaid for the accounts you turn on. Creates Wealthfolio accounts or links existing ones; a link can change until the first push.
- Checks the first push to an account against data already there, so nothing is added twice. Rows it pushed before are linked back by their `plaid:<id>` note.
- Bank and card rows with spending on: sets a Wealthfolio category from Plaid's once, so later edits stay. A row left without one gets it after a later push, with no new Plaid pull. After a push that adds rows, re-runs your categorization rules. Leaving Accounts warns when spending is off.
- Links transfers it can pair between your synced accounts. A transfer to an account it can't see stays unlinked.
- Sync shows progress per connection, a dry run before every push, and to-do cards that say where to fix each item. Rows Wealthfolio refuses stay on screen with its reason. A dry run reuses the Plaid pull for 15 minutes.
- Daily sync runs at a set time (HH:MM) while Wealthfolio is open, stops to ask when a decision is needed (possible duplicates, a security to review, a moved ticker), and shows the last run per account and the last 7 runs. Changes in the addon wait while it runs. Its switch does not sync to paired devices, so they do not push the same rows twice, and only one open window runs it.
- Securities can change after a push: a security that starts to be imported gets its full history, and rows pushed under a ticker now set elsewhere are offered for delete, then imported again.
- Full backup (recommended): connections, account selections, sync settings and the ledger. Connections backup: connections and their access tokens only. Both are saved through Wealthfolio's save dialog. Restore loads a pasted backup or a file and asks first: Restore keeps what is here and fills in the rest; Overwrite replaces it, after a second confirmation that lists the connections it removes.
- Work keeps running, and keeps its progress, when you switch steps. Changes save at once; the control fades into a ✓ for a moment, and a button shows its success on itself, so nothing on the screen moves. A failed save shows as a notification.

### Institution quirks handled

Found in real data. Each has a test and an entry in [DECISIONS.md](docs/DECISIONS.md).

| Problem | Handling |
|---|---|
| 401(k) trust or DAF pool with no public ticker | Held as units of a followed ETF; ratio updates with newer prices (changes over 5% wait for you). |
| Merrill reports a reinvestment twice (0-share memo, then the fill) | Drops the memo when a matching fill is within 7 days. |
| Merrill and Fidelity report splits as cash rows or distributions | Imported as SPLIT. |
| 401(k) same-day out-and-back pairs | Dropped. |
| RSU vests as $1 withdrawals; share journals with no price | Share transfers in at that day's close. |
| Bilt rent as a charge plus a same-day credit | Pair dropped on the card, so rent isn't counted twice. |
| Card rewards and statement credits | Imported as credits, not transfers. |
| Brokerage window shown twice | Flagged; leave out one side. |
| Bank sweep or money-market fund shown as trades | Treated as cash. |
| No cost basis for older positions or vests | Yahoo close on that date. |
| Same-day transfers with equal amounts | Paired by shared reference (e.g. Chase `transaction#`). |
| Account rebuilt a day later opens a day later | New opening rows use the shared history start. |
| Split after an opening position or trade (Plaid's cost basis and Yahoo closes use today's shares) | Opening price scaled by the later split factor. A trade price already split-adjusted is scaled back and listed in the to-do list. |
