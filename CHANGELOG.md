# Changelog

Versions follow [semantic versioning](https://semver.org).

## 0.1.4 - 2026-11-27

Tested with Wealthfolio 3.12.0 and 3.13.1.

### Added

- A connection that lacks a product its accounts need, such as `investments` for a 529 linked with only `transactions`, is added automatically when you link it. Before, its investment accounts were marked unsupported and nothing imported.
- An older connection that lacks such a product shows an "Add investments" button on Connections. If Plaid needs your consent, or the bank login expired, the button opens one Plaid sign-in that renews the login and asks for the consent together.
- A product the institution does not offer gets no button. For example, Plaid has no investment data for New York's 529 College Savings Program.

## 0.1.3 - 2026-11-24

Tested with Wealthfolio 3.13.1.

### Fixed

- On a phone, the progress list on Sync and Accounts no longer squeezes its rows so that each one scrolls on its own. Wealthfolio clips flex layouts on screens up to 1024px wide, in both mobile and desktop mode.
- Turning daily sync on and then changing its time right away keeps the new time. Before, the older time could be saved last.
- When a pushed trade changes its shares or cash, for example after a mapping fix, that ticker's opening position and the account's opening cash are recalculated. An opening that is no longer needed is deleted. Before, it stayed, and the holdings check showed a mismatch. Rows you edited stay as they are, together with the openings that depend on them.
- A row that the importer updated can be updated again. Before, Wealthfolio flagged it as user modified, so the importer treated it as your edit. A flagged row now counts as yours only when its values differ from what the importer last wrote, or it is void.
- An update keeps the row's notes. Before, it cleared them.
- "Kept as they are in Wealthfolio" shows each row's ticker, the value in Wealthfolio and the new value.
- A new ratio for a followed ticker also rescales pushed rows that Plaid no longer sends. Rows you edited stay.
- An opening without a Plaid cost keeps its price from the last push when Yahoo has no close for its day.
- A failed Yahoo lookup no longer hides saved closes of past days.
- Shares contributed to a plan, such as a 401(k) contribution, are marked external, so Wealthfolio counts them as net contributions. Rows already pushed do not change: turn on External on each in Wealthfolio.

## 0.1.2 - 2026-11-21

Tested with Wealthfolio 3.12.0. Works with 3.13.

### Fixed

- A security that Plaid calls a derivative but that you map to a stock ticker in Securities imports as that stock. Before, it was an option worth 100 shares a unit: a Robinhood buy of 2 ANT shares became 0.42 contracts, and the rest showed up as a free opening position. A partially filled option trade now counts the filled contracts.
- Restore (keep what is here) brings back the access tokens of connections that lost them, for example after `WF_SECRET_KEY` changed. Before, it skipped every connection that already existed, so they stayed without a token. The README now explains `WF_SECRET_KEY` for Docker users.
- A ratio update fetches the ticker's newest closes before it proposes a ratio, and uses the nearest close in the lookback, with its date. Before, a stale cached close could set the ratio.
- An account without a full history pull, or with rows dated before its last sync, is pulled again in full. An account that holds a tracked fund is backfilled on a full pull.
- Reconciliation compares holdings with the quantities this pull will update, so a new ratio no longer shows false differences.
- Pressing Enter to confirm an IME candidate in the initials field no longer submits it.
- A failed read on Setup, Connections, Accounts, Sync, Daily sync, or when the addon starts shows an error. Before, the screen stayed blank or out of date. A backup file that cannot be read shows an error.

## 0.1.1 - 2026-11-11

Tested with Wealthfolio 3.12.0. Works with 3.13.

### Fixed

- The Copy button on Backup and the "rows were not saved" popup on Sync use layout classes that Wealthfolio 3.13 still has. With 0.1.0 on 3.13, the Copy button could be narrower and the popup had no height limit of its own.

## 0.1.0 - 2026-11-09

Tested with Wealthfolio 3.12.0.

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
