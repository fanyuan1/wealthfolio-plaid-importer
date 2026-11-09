# Plaid Importer: decisions and build record

This records what was decided, why, and what was built. Read it before you change behavior. Dates are absolute. Initial design and build: 2026-11-05.

## 1. Goal

Pull financial data from Plaid into Wealthfolio 3.12 desktop, inside the app, as a Wealthfolio addon. No terminal, no second program, and no data outside the computer except calls to Plaid and Yahoo Finance.

## 2. Scope

Example household (made up):

| Person | Institutions | Items |
|---|---|---|
| AB | Bank of America, Chase, Fidelity (401k), Charles Schwab, Vanguard | 5 |
| CD | Chase, Vanguard, Charles Schwab, Robinhood | 4 |

- One Item per person per institution login. Plaid's plan limit is the user's to track: no Plaid API reports Items used.
- **Out of scope:** loans and mortgages. HSA and 529 providers: Plaid coverage for them is unverified.
- **Options** are supported (D16). Exercise and assignment go to the to-do report.
- **Brokerage-window overlap:** a retirement plan can hold part of its money in a self-directed brokerage window at another linked broker. The broker is the source of truth. Leave out the plan's view of it (see 5.4).

## 3. Decision log

| # | Decision | Chosen | Why |
|---|---|---|---|
| D1 | Data scope | Investments, bank and credit cards | Wealthfolio 3.12 has CASH and CREDIT_CARD accounts and a Spending module |
| D2 | Runtime | A Wealthfolio addon on a pure TypeScript importer (`src/importer/`): mapping, planner, push, Plaid client, prices and naming, with tests | Runs inside the app; the core is testable without the app (2026-11-07) |
| D3 | Money | big.js with 28 decimal places and half-even rounding; ledger values compare at 8 decimal places | Exact decimal math; rounding noise is never an update |
| D4 | Secrets | Plaid client ID and secret, and each access token, in the system keychain through the addon SDK. Everything else in addon storage, per Plaid environment | Tokens never land in Wealthfolio's database or synced storage |
| D5 | Environments | Sandbox and Production keep separate connections, accounts, securities settings and ledger. The title says [Sandbox] in Sandbox. Use a separate Wealthfolio profile for Sandbox | Test data must never touch real data |
| D6 | Steps | A stepper 1. Setup → 2. Connections → 3. Accounts → 4. Sync → 5. Daily sync → 6. Backup. Done steps show ✓; Sync and Daily sync show a lock with the reason until every selected account is linked; Backup is never locked, so a restore works on a new computer. Each step has short directions. There are no Next buttons: the ✓ marks show what is done (2026-11-08). Leaving Accounts by any step warns when spending is off for a synced bank or card account (D42). The addon opens on Setup until a push has worked, then on Sync | A first-time user follows the order; a returning user wants Sync |
| D7 | Plaid Link | Hosted Link. The addon shows the link with Copy (an addon cannot open a browser), then asks `/link/token/get` every 3 seconds for up to 30 minutes and shows the result: connected, or the reason the login did not finish. Reconnect works the same way and exchanges no token. Sandbox also offers a test bank with no login | Wealthfolio's addon frame blocks `window.open` and Link's iframe |
| D8 | Products per link | `transactions` required; `investments` and `auth` optional | Optional products never fail Link; `auth` lets Chase offer "always" consent |
| D9 | Reconnect | Update mode with the existing access token: same Item, no new Plaid connection | Removing an Item never frees a Plaid connection |
| D10 | Existing connections | Connections takes one access token (Plaid returns the institution, products and accounts; the user types only the initials). Backup (step 6) makes a **connections backup** (connections and their tokens only; Accounts reads their accounts again after a restore) or a **full backup** (also account selections, securities settings, pending securities changes (D30) and the ledger), as `plaid-importer-backup` with a `kind`. Save as file uses Wealthfolio's save dialog (`files.openSaveDialog`); the webview ignores browser downloads. The full backup is the recommended one: it also keeps the user's Discard decisions, which a connections backup would ask for again. Restore asks first. **Restore** merges: what is already there wins. **Overwrite** (a second confirmation lists what it removes) replaces what the backup holds; connections the backup lacks are removed with their tokens and accounts; activities in Wealthfolio are not touched. A full backup whose Wealthfolio accounts are all missing here restores without the ledger and pending changes. Version 0.1.0 starts this format; later versions keep reading it | Moving to another computer must not use new Plaid connections. A ledger restored into other Wealthfolio data would block rows the user deleted from being pushed again; rows with the importer's `plaid:<id>` note are linked back on the first push (D41), so a restore without it loses only the incremental pull (2026-11-08) |
| D11 | People | Initials (1–4 letters) start every account name and become the Wealthfolio account group. Plaid's `client_user_id` is `plaid-importer-<initials>` | Initials tell accounts apart |
| D12 | Accounts | Every shared account is listed, off by default; Select all turns on every supported one. Each selected row has a **Previous account** list: the Wealthfolio accounts of the same type that no other row uses, with the closest name (or a shared account number) preselected, or **New**. Created and Spend tracking show the state of the account the row will use. The button creates the New ones and links the rest (2026-11-07). New accounts are created with `trackingMode: TRANSACTIONS`. Loans and mortgages are not supported | Share every account in Link; choosing later is one switch |
| D13 | Account names | `AB · InstShort PlaidName ••mask`, at most 50 characters (Wealthfolio's form limit). InstShort comes from `src/importer/abbreviations.json` (longest prefix match), else Plaid's name. The word "Plaid" is removed. When too long, the institution is trimmed first (to at least 12 characters), then the account name, with …; duplicates get (n) | Sandbox names passed 50 characters; generated abbreviations looked odd (2026-11-05) |
| D14 | Account currency | Plaid's balance currency, else the institution's country currency | Wealthfolio cannot change an account's currency later |
| D15 | History | About 24 months on the first pull (729 days), then incremental: investments re-pull 14 days, transactions use the `/transactions/sync` cursor. Pending transactions are never imported | Plaid's investments limit; late and corrected rows are caught |
| D16 | Options | OCC compact symbol from `ticker_symbol` or `option_contract`; instrument type OPTION; Plaid's quantity (single options) ÷ multiplier 100; POSITION_OPEN/POSITION_CLOSE subtypes; holdings scaled the same way | Wealthfolio prices options per share with a contract multiplier |
| D17 | Bank and card rows | Every posted transaction becomes an activity (5.3), so the cash balance stays right. Card rewards and statement credits named CREDIT without PAYMENT are CREDIT, not payments | Cash must reconcile; credits looked like card payments |
| D18 | Opening positions | TRANSFER_IN at the window start = holdings − pulled net change, at Plaid's cost basis. Without a cost basis: the Yahoo Finance close that day (cached; the last close within 7 days), else the earliest Plaid price. Each one goes to the to-do report. After a later split the price is multiplied by the split factor (D45): cost basis and Yahoo closes count today's shares, the opening quantity counts the shares of that day | Older positions would go negative; Plaid has cost basis only for current holdings; VGT openings priced 8× too low (2026-11-07) |
| D19 | Shared history start | A new opening row is dated at the earliest opening in the ledger when Plaid's window starts within 31 days of it; later-linked accounts open at their own window start | An account rebuilt a day later opened a day later and the chart jumped (2026-11-07) |
| D20 | Cash sweep | `is_cash_equivalent` or `type: cash` is cash, and its buys and sells are dropped. Merrill's bank sweep (type other, ticker "Deposit") too | Avoids double-counted cash |
| D21 | Corrections | Plaid edits update the Wealthfolio activity. Plaid removals, and rows the mapping now drops, are deleted; the ledger keeps them voided so they never come back. Linked transfer legs are voided | Wealthfolio's Spending counts VOID rows with their category (2026-11-07) |
| D22 | Corporate actions | SPLIT with a computed ratio; dividend reinvestment as DIVIDEND + BUY as Plaid reports it. Merger, spin-off, exercise and assignment go to the to-do report. Merrill and Fidelity splits (cash row with new shares at price 0, or a distribution) become SPLIT | Rare; automatic handling is risky |
| D23 | Institution quirks | Stock plan: a share transfer with no cash goes out (Schwab journals); shares on a cash row are an RSU vest, TRANSFER_IN at that day's close. A cash journal tagged with a security is a cash transfer. A 401(k) `buy/contribution` is a TRANSFER_IN. A "partially filled" order uses amount ÷ price. 401(k) same-day out-and-back pairs are dropped. Merrill's zero-quantity reinvestment memo is dropped when a fill with the same amount is within 7 days. A Bilt card's rent charge plus same-day credit is dropped | Found in real data; each has a test (2026-11-06 to 2026-11-07) |
| D24 | Transfers | Legs across linked accounts are paired within 3 days, same amount and currency, both with Plaid's transfer or card-payment category, and linked in Wealthfolio. Legs that share a reference number (6+ digits, e.g. Chase `transaction#`) pair first | Unlinked transfers count as spending (2026-11-07) |
| D25 | Categories | Plaid's personal finance category → a Wealthfolio Spending category, set once after import, so the user's changes stay. Current income keys: `INCOME_SALARY`/`INCOME_WAGES` → income_salary, `INCOME_CONTRACTOR` → income_freelance. A failed batch is retried one row at a time | Plaid first, the user wins after; one bad row must not leave the rest uncategorized |
| D26 | The user's rules | After a push that imported rows, Wealthfolio's categorization rules run on uncategorized rows | Wealthfolio applies rules only on a rerun (2026-11-07) |
| D27 | Securities | Automatic: Plaid's ticker plus the exchange suffix (`.TO`), `BTC-USD` for crypto, OCC for options. Sync → Securities sets one per security: Input ticker, Follow ticker (D28), Price from activities (manual quotes), Cash, Money Market Fund (a holding), Leave out. Automatic is not offered when it gives no symbol. Each option has a hover explanation. Before the list shows, every automatic ticker is checked with Wealthfolio's ticker search (exact symbol match); the table appears when all checks are done, so rows do not move. Matching holds the tickers that match and that Wealthfolio can look up; Needs attention holds the rest (Review, then Change once saved). Input ticker is checked as you type. When Wealthfolio does not know a ticker, it shows the symbols the search returned. The addon does not rewrite Plaid's tickers (BRK.B stays BRK.B) | Plaid often has no ticker for 401(k) trusts and 529 units; the user picks the spelling Wealthfolio accepts (2026-11-07) |
| D28 | A fund without quotes follows a ticker | `track: {symbol, date, price, close, ratio}`, ratio = fund price ÷ the ticker's close on that day (Yahoo Finance, or typed); when that day has no close, the closest day with one is used and shown. Plaid rows are rewritten in the ticker's units (quantity × ratio, price ÷ ratio, amounts unchanged), so Wealthfolio prices it daily. Accounts holding a tracked fund get full history each pull, so a new ratio updates pushed quantities | Wealthfolio's market data has no indexes; uploading daily quotes was rejected (2026-11-06) |
| D29 | Ratio updates | When Plaid's `institution_price` is newer than the stored ratio, the dry run proposes a new ratio from the ticker's close that day (no close yet: wait). The user confirms each one; the daily sync applies changes up to 5% and reports bigger ones | Price-only tickers drift from a fund that reinvests (2026-11-06) |
| D30 | Moved securities | When a pushed security now maps to another symbol, to cash or to Leave out, the dry run blocks Push and offers to delete its pushed activities (two clicks); the next push imports them again as set now, from the account's full history, and rebuilds its opening rows. Saving a security records the change (`remap_<env>`), so rows outside the 14-day pull are caught too. A security that starts to be imported (from unmapped, cash or Leave out) gets the same full pull and rebuilt openings. The full pull repeats until a push saves every row | Wealthfolio cannot move an activity to another asset. An incremental pull would never reach older rows (2026-11-09) |
| D31 | Dry run, then push | Dry run pulls from Plaid and plans; Push sends exactly that plan. After a securities change, Push is off until Update preview re-plans from the same pull (no new Plaid call). A fund newly set to Follow ticker needs a new dry run for its full history | The push matches what the user saw (2026-11-07) |
| D32 | Push through the addon SDK | `checkImport` once per distinct security (only security rows; it requires a symbol), then `saveMany` creates in chunks of 500 with the resolved asset identity; updates and deletes in chunks of 100. Comments carry `plaid:<id>`. The check runs with `forceImport`, and only a problem with the security itself (symbol, asset, quote) fails its rows: its verdict on the one row it checked (a duplicate, a date) says nothing about the others. Every update carries the activity's currency, which `save_activities` requires. Rows Wealthfolio rejects keep its reason, appear in a dialog, and count against the daily sync. The ledger is saved even when a later step fails. While a push runs, a dialog shows its progress and asks the user to keep the window open | Resolving a symbol per row was slow; cash rows have no symbol (2026-11-07). A duplicate flag on one VUSXX row failed every VUSXX row (2026-11-07) |
| D33 | Storage parts | Addon storage caps each value at ~250 KB. A value over 50,000 characters is stored as parts keyed by content hash, with a head listing them, written last; unchanged parts are not written again | The ledger passed the cap on the first push (2026-11-07) |
| D34 | Daily sync | A 1-minute timer while Wealthfolio is open runs once a day after the set time (`HH:MM`): dry run, small ratio changes (D29), push. It stops if pushed activities moved (D30), if rows may already be in Wealthfolio (D41), or if Wealthfolio refused rows; it waits while the page is open, retries 2 hours after a failure, and shows the result as a toast and on the Daily sync step: status (Succeeded, Needs you with a button to the step that fixes it, Failed), next run, counts per account, and the last 7 runs. Run now starts one at once. A run that pushed counts as done for the day. To-do items do not stop it; the run points to Sync, which shows the to-do list of what is left. The on/off switch is kept in this computer's keychain, which never syncs; the time syncs with the other settings | Wealthfolio must be open to receive data anyway (2026-11-07). Addon storage syncs to paired computers, so a synced switch would run the sync on both, and both would push the same rows (2026-11-09) |
| D35 | Repairs | No delete or re-import action. Push fills in missing categories by itself: it re-pulls bank and card history only when pushed rows still lack a category | Fix a wrong mapping or a failed category push without losing data (2026-11-07) |
| D36 | Reconnect | Each pull checks Item health; a blocked Item is skipped with a Reconnect button to Connections, and the others sync. No warning before a bank's consent ends: the user reconnects when a pull fails | No webhook: the addon has no public server. An early warning on every pull added noise for something a failed pull already says (2026-11-08) |
| D37 | Reconciliation | Plaid holdings vs ledger positions each pull; differences go to the to-do report | Some institutions' investment transactions are unreliable |
| D38 | To-do report | After the dry run, review rows print as grouped steps that say where to fix them in the addon or in Wealthfolio. Failed Yahoo Finance lookups warn first | The user needs one list of what is left |
| D39 | Open source | Code, tests and docs use made-up people (AB, CD) and amounts. MIT license | Real account ids, masks and amounts must never reach the repo (2026-11-07) |
| D40 | Testing | vitest on recorded payloads and fakes of Wealthfolio and its storage limit → Plaid Sandbox in a separate Wealthfolio profile → real links | Real links cost permanent Plaid connections |
| D41 | Existing data | **First push to an account** (the ledger has no row for it): after the securities are mapped, Sync lists every row Plaid would add, newest first, in New, Similar and Exact groups. New starts as Add; Similar and Exact start as Discard. The user decides per row or per selection (Add, Discard) and rows keep their place. Compare shows Plaid's version beside Wealthfolio's. A row Wealthfolio holds with our `plaid:<id>` note (whole word) is linked back as the importer's own without asking, on every push, so a restore without the ledger keeps Plaid's later changes flowing (2026-11-08). Exact: same day, ticker and amount; shares transferred in match any activity with the same shares that day. Similar: same day and amount, another type name. An opening position is compared with the sum of the account's earlier activities in that ticker: equal is Exact, different is Similar. There is no true-up of missing shares. Discarded rows are linked or recorded in the ledger as `adopted`, keep their category, and are not offered again. Nothing blocks Push; the header counts what will be added and discarded. **Later pushes:** rows already held under their `plaid:<id>` note are linked silently, not added again. Daily sync stops when the list has Similar or Exact rows | A moved database, a lost ledger, a relinked bank or an earlier CSV import no longer duplicates history (2026-11-07, redesigned 2026-11-07) |
| D42 | Spending flag | Accounts shows whether Spending is on for each bank and card account, read from Wealthfolio, also for the existing account a row will link to. The addon SDK cannot turn it on (its spending API is read-only). Leaving Accounts for any other step with spending off for a synced bank or card account opens a dialog: Stay here, or Continue anyway. Leaving the addon through Wealthfolio's sidebar cannot be caught. Rows pushed without it have no category; each push finds rows with none and sets them once spending is on (D35) | Spending is a Wealthfolio setting (2026-11-07) |
| D43 | Old data wins | The importer never changes or deletes an activity it did not create or that the user edited: rows linked from existing data are marked `adopted` in the ledger, and activities Wealthfolio flags as user-modified count the same. Plaid changes, removals, transfer retypes and transfer links for them are dropped from the plan and listed under "Kept as they are in Wealthfolio". Repairs (retrack) skip adopted rows. A restore replaces what is already stored only when the user picks Overwrite and confirms it | Explicit consent only: the user edits or deletes the row in Wealthfolio (2026-11-07) |
| D44 | Wiped account | Each dry run counts the activities Wealthfolio holds for every synced account the ledger has rows for. At zero, the addon forgets the account's rows and its Item's cursor, so the next pull is a first pull and pushes everything again. An account with any activity is left alone; one that cannot be read is skipped. The cursor reset applies to the whole Item; its other accounts' rows stay in the ledger and are not pushed twice | After a wipe the ledger said everything was pushed and the cursor said nothing was new (2026-11-07) |
| D45 | Splits and prices | A security's SPLIT ratio comes from the position before it (D22). Opening prices from cost basis, from a Yahoo close and from today's price are multiplied by the product of the splits after the opening, because those prices count today's shares and the opening quantity counts the shares of its day. Plaid sometimes prices a trade from before a split in today's shares: for a buy, sell or transfer before a later split of 1.5× or more, a price within 30% of Yahoo's (split-adjusted) close, and not within 30% of the close times the splits, is multiplied by them. Each correction is a to-do item with both prices. Rows with a market price, opening rows and smaller splits are skipped | VGT's 8-for-1 split priced Chase and Schwab openings at $44 instead of $350 and the return looked huge; a Schwab transfer carried an adjusted price on an old quantity (2026-11-07) |
| D46 | Ticker lookup | Wealthfolio's own ticker search, exact match on symbol, canonical symbol or provider symbol. A Yahoo-close test was tried (SCBP1, BRK-B) and removed, because Wealthfolio's answer is the one that decides whether an asset can be created, and the user can pick from its suggestions | The user must choose a setting Wealthfolio accepts (2026-11-07) |
| D47 | Releases | A `vX.Y.Z` tag runs a GitHub Actions workflow that checks the tag against `manifest.json` and `package.json`, runs the type check and tests, builds the zip and publishes a release. `dist/` is not tracked. CI runs the same checks on every push and pull request | Users download a built zip instead of building; a tag cannot ship a mismatched version (2026-11-07) |
| D48 | Progress, no log | The engine reports progress as events (one line per connection, its bank and investment pulls nested below, then one line per push stage). Sync shows them in a list that scrolls after a few lines. Every result that needs the user is an alert or a to-do card with a button to where it is fixed. The raw log is kept only in memory; it is not shown | The log mixed actions, progress and debug text, and the user could not tell what to do with it (2026-11-08) |
| D49 | Saving | Toggles, picks, initials and the daily sync time save on change. The control shows it: it fades into a green ✓ for a moment, in its own space. A failed save is a toast. Only Save keys (it checks the keys with Plaid) and the security editor's Save (it turns off Push until Update preview) are buttons | Every change is one control, so a Save button would add only unsaved-change handling (2026-11-08) |
| D50 | Initials | The initials of a connection can be changed in Connections. The change renames only accounts not yet created in Wealthfolio; activities point to accounts by id and do not change | A typo at Connect otherwise costs removing the connection and adding its token again (2026-11-08) |
| D51 | Account refresh | Accounts are read again after Connect and Reconnect, and when Accounts opens for each connection not checked in the last day. The automatic refresh never calls Identity, which Plaid bills per call; joint flags stay from the last call | New accounts at an institution show up without a button (2026-11-08) |
| D52 | Work outlives the screen | Dry run, push, Update preview, deleting a moved ticker, the daily sync (also when the timer starts it), the account refresh, creating accounts and restore run as engine tasks. A task keeps its progress, log, result and error until the next run of the same kind, so leaving a step and coming back shows where it is. The Sync view lives in the engine for the same reason | Switching steps lost a running sync's progress (2026-11-08) |
| D53 | Account links | The selector and Create use one link plan: user picks first, then the closest names, in name order; a Wealthfolio account goes to one row only and leaves the other rows' lists. A linked row has Change until the first push to it, then shows a lock: moving pushed rows would mean deleting and importing them again. A Wealthfolio account the addon created stays after Change | Two rows could pick the same account, and the second silently got a new one (2026-11-08) |
| D54 | Reconnect flag | A pull that finds a login expired flags the connection; Connections shows Reconnect needed and makes its Reconnect button primary. A good pull or a finished reconnect clears it | The user fixes connections in one place (2026-11-08) |
| D55 | After a push | The push plans again from the same Plaid pull against the saved ledger, so the screen keeps the securities and shows what is left: rows Wealthfolio refused come back as new, and their securities move to Needs attention with Wealthfolio's reason. A dry run reuses a pull of the same connections, accounts and followed funds for 15 minutes; Pull fresh from Plaid forces a new one, and the daily sync always pulls | Closing the failed-rows dialog wiped the screen, and the next dry run pulled everything again (2026-11-08) |
| D56 | Joint accounts | Select all turns on one copy of a joint account linked under several owners (same institution, mask and subtype). Accounts warns when both copies are on | Both copies hold the same activity, so syncing both counts it twice (2026-11-08) |
| D57 | Feedback in place | A success shows on the control that caused it, for a moment: the button fades into a green ✓ label (Copied, Saved, Added, Keys work), then back. Its width fits both labels. A control that saves on change shows the ✓ on itself (D49). Status that lasts (a running check, errors, results) goes below a section's buttons, never above its title. Nothing appears beside a control and pushes others aside | Messages that came and went moved the controls next to them, so the screen jumped (2026-11-09) |

## 4. Research facts relied on

Verify these again if behavior looks wrong. Sources: Wealthfolio repo `afadil/wealthfolio` at v3.12.0 and its addon SDK 3.12 (read 2026-11-05 to 2026-11-07), plaid.com/docs.

### Wealthfolio 3.12

- **Activity types (14):** BUY, SELL, SPLIT, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, FEE, TAX, CREDIT, ADJUSTMENT, UNKNOWN.
- **Amounts:** use absolute values. The activity type gives the direction.
- **Symbol:** required for BUY, SELL, SPLIT, DIVIDEND, ADJUSTMENT. Non-US tickers use Yahoo suffixes (`TD.TO`). Crypto uses `BTC-USD`. Unknown tickers need `quoteMode: MANUAL`.
- **Subtypes:** core acts on DRIP, STAKING_REWARD, DIVIDEND_IN_KIND, BONUS, REBATE, REFUND, REIMBURSEMENT, OPTION_EXPIRY, RETURN_OF_CAPITAL, NOTIONAL_DISTRIBUTION, CONVERSION_OUT/IN, POSITION_OPEN, POSITION_CLOSE. Others are labels.
- **Options:** contract multiplier defaults to 100 for OPTION; OCC symbols are accepted compact or padded.
- **Spending** covers only opted-in CASH and CREDIT_CARD accounts. A linked transfer pair is not spending. A row counts as Savings only when it is a linked transfer to an account outside Spending.
- **Addon SDK:**
  - `accounts.getAll/create` (NewAccount needs `isDefault`, `isActive`; names 2–50 characters).
  - `activities.checkImport` requires a symbol on every row. `saveMany({creates, updates, deleteIds})` returns `createdMappings {tempId, activityId}` and `errors {id, action, message}`. An update replaces the whole activity, so it needs id, accountId, activityType and activityDate. `linkTransfer(a, b)`.
  - `spending.getCategories`, `assignCategory(id, kind, categoryId)`, `rerunRules(true)`.
  - `secrets` (system keychain), `storage` (string values, ~250 KB each, replicated to paired devices), `files.openSaveDialog` (native save dialog), `network.request` only to `network.allowedHosts` in the manifest. `toast`, `query`, `logger` and `storage` need no permission.
  - The addon page runs in a frame that cannot open windows or show Plaid's Link iframe.
  - Install: Settings → Add-ons → Install from file (zip with `manifest.json` and `dist/addon.js`).
- **Profiles:** the desktop app has several profiles. Use one for Sandbox.

### Plaid

- **Trial plan:** Production Items limited (the count is in the Plaid Dashboard). `/item/remove` does not free a slot. No API returns Items used. US and CA only. Immediate OAuth access, including Fidelity and Schwab.
- **Sandbox:** First Platypus Bank `ins_109508` links without a login page through `/sandbox/public_token/create`.
- **Account selection:** Plaid's Account Select pane (Dashboard → Link customization) and, at OAuth banks, the bank's own consent screen. `onSuccess` metadata returns the institution and the selected accounts.
- **Items:** one Item per institution login.
- **Investments:**
  - `/investments/transactions/get`: ≤24 months, `count` ≤500 + `offset`. `PRODUCT_NOT_READY` right after link (retried).
  - Signs: `amount` > 0 means cash out. `quantity` < 0 means a sell.
  - `ticker_symbol` is often null for 401k CITs and 529 funds. CUSIP and ISIN are null without a license.
- **Transactions:**
  - `/transactions/sync` uses a cursor. Restart on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`.
  - Signs: `amount` > 0 means money out.
  - `days_requested` (730) is honored only at link time.
- **Link and consent:**
  - Hosted Link: `/link/token/create` with `hosted_link: {}` returns `hosted_link_url`; `/link/token/get` returns the session's `public_token` when the user finishes.
  - Update mode with `account_selection_enabled` re-auths and adds accounts on the same Item.
  - At Chase and Schwab, relinking with fresh Link creates a new Item and can invalidate the old one. Chase consent: 6 months, 1 year, or "always" (needs Auth).
  - The BoA consent lasts 12 months.
- **Reported data quality:**
  - Vanguard investment transactions can be missing (holdings are reliable).
  - HealthEquity often links only the cash portion.

## 5. Build

### 5.1 Layout

```
src/importer/         pure: no addon SDK, no React
  dec.ts              big.js decimal helpers (D3)
  models.ts           Activity and Review, position and cash deltas
  securities.ts       Plaid security -> symbol (settings, exchange suffix, crypto, cash, option)
  mapInvestments.ts   investment transaction -> Activity (5.2)
  mapTransactions.ts  bank and card transaction -> Activity (5.3)
  categories.ts       Plaid category -> Wealthfolio category key
  transfers.ts        3-day transfer-leg matcher (D24)
  positions.ts        opening positions, split ratios, holdings reconciliation
  tracking.ts         funds held as units of a ticker; ratio updates (D28, D29)
  ledger.ts           ledger rows, cursors, diff for updates
  plan.ts             plan: pure, reads the ledger
  push.ts             push a plan through a Writer and record it
  plaid.ts            Plaid REST client over a pluggable transport
  fetch.ts            pull every Item; one broken Item never stops the others
  prices.ts           Yahoo Finance daily closes, cached
  accounts.ts         account names, settings, currencies, closest-name suggestion (D12, D13, D14)
  adopt.ts            check new rows against Wealthfolio's activities: plaid:<id> note, content, opening (D41)
  abbreviations.json  institution name -> short name
  todo.ts             to-do report
src/engine/           no React
  store.ts            addon storage in parts (D33), keychain, settings
  engine.ts           connections, accounts, dry run, push, daily sync, repairs, backup
  writer.ts           Writer over the addon SDK (D32)
src/ui/               the six steps: setup, connections, accounts, sync (with securities, matches and daily sync), backup; page and shared pieces
src/index.tsx         registers the page and the daily sync timer
test/importer/        mapping, account naming, multi-run plan + push with a fake Wealthfolio
test/engine/          storage parts, backup, daily sync, repairs, writer
test/boundary.test.ts src/importer imports neither the SDK nor React
```

### 5.2 Sync pipeline

1. **Fetch:** for each Item, check health. Pull investments from the last end − 14 days, or 729 days back on the first pull, plus holdings. Drain `/transactions/sync` from the cursor. On the first sync, also read balances.
2. **Plan:**
   - Map the rows. Add opening rows on the first pull per account. Resolve split ratios.
   - Compare with the ledger. Unknown ids are new rows. Changed fields are updates. Cancelled or removed ids are deleted.
   - Match transfers over the new rows plus unpaired ledger legs near them.
   - Map categories. Reconcile holdings. Securities without a symbol are listed in Securities.
3. **Push:** create, update and delete activities; link pairs; set categories; run the user's rules. Save the cursors last, so a failed push re-pulls the same data.

### 5.2.1 Mapping table (investments)

| Plaid type/subtype | Wealthfolio |
|---|---|
| buy/* (incl. contribution, reinvestment) | BUY (POSITION_CLOSE for buy to cover) |
| sell/* | SELL (POSITION_OPEN for sell short) |
| option buy / sell / sell short / buy to cover | BUY POSITION_OPEN / SELL POSITION_CLOSE / SELL POSITION_OPEN / BUY POSITION_CLOSE; quantity ÷ multiplier (contracts), price per share |
| buy/sell of a cash security | dropped |
| cash/dividend, qualified, non-qualified, LT/ST capital gain | DIVIDEND (QUALIFIED / ORDINARY); on a cash security → INTEREST |
| interest, interest receivable | INTEREST |
| tax, tax withheld, non-resident tax | TAX (WITHHOLDING) |
| fee/* | FEE (MANAGEMENT_FEE, INTEREST_CHARGE); negative → CREDIT/REFUND |
| deposit, contribution (cash) | DEPOSIT (transfer candidate) |
| withdrawal, distribution | WITHDRAWAL (transfer candidate) |
| transfer with security | TRANSFER_IN/OUT by quantity sign |
| transfer without security | DEPOSIT/WITHDRAWAL by amount sign (transfer candidate) |
| split | SPLIT, ratio = (pos + delta) / pos |
| expire | ADJUSTMENT/OPTION_EXPIRY, quantity in contracts |
| cancel | drop both, void if already pushed |
| merger, spin off, exercise, assignment, adjustment, return of principal, unknown | review |
| unmapped security (no ticker, no OCC symbol) | review |
| pending credit/debit | dropped |

### 5.3 Bank and card mapping

| Account | Plaid amount | Wealthfolio |
|---|---|---|
| cash | > 0 | WITHDRAWAL (FEE if PFC BANK_FEES) |
| cash | < 0 | DEPOSIT (INTEREST if INCOME_INTEREST_EARNED) |
| credit | > 0 | WITHDRAWAL (FEE / INTEREST_CHARGE for bank fees) |
| credit | < 0, card payment or transfer | TRANSFER_IN (transfer candidate; Wealthfolio rejects DEPOSIT on cards) |
| credit | < 0, other | CREDIT/REFUND |

Transfer candidates have a PFC primary of TRANSFER_IN or TRANSFER_OUT, or the detailed category LOAN_PAYMENTS_CREDIT_CARD_PAYMENT. Rows from investment accounts in `/transactions/sync` are ignored, because the Investments product covers them.

### 5.3.1 Opening balances

- **Investment accounts:** for each symbol, the opening quantity is the current holding minus the sum of position deltas, so it is in the shares of the opening day. The price is `cost_basis / quantity` times the splits since (D45). Without a cost basis, it uses the market close that day (D18) and adds a to-do item.
- **Cash and card accounts:** the opening cash is the current balance minus the sum of cash deltas. Card debt is negated.
- **Signs:** a positive opening is written as TRANSFER_IN. A negative cash opening is written as TRANSFER_OUT. A negative security position goes to the to-do report.

### 5.4 Brokerage-window overlap

- **Holding line:** holdings whose name matches `self-directed|brokerage link|brokerage window|brokerage account|sdba|schwab` raise a "possible brokerage window" to-do item. Choose Leave out for that security in Sync → Securities.
- **Separate account:** if the plan reports the window as its own account, turn it off in Accounts.

## 6. Verified vs not verified (2026-11-08)

**Verified**
- vitest: 107 tests (mapping, naming, matching against existing activities, split prices, multi-run plan + push with a fake Wealthfolio, storage parts under the size limit, both backup kinds, merge and overwrite restore, initials, login polling, progress events, daily sync time, switch and history, daily sync rules, securities changes after a push, writer). `tsc` is clean.
- Plaid Sandbox through the core: Hosted Link returns a URL; a 1,013-row plan.
- Inside Wealthfolio, Sandbox profile: install, keys, connections, Accounts, Dry run, and Push reaching `saveMany` (it found the `checkImport` symbol rule and the storage size limit, both fixed).
- A real backup of 14 connections and 4,374 pushed rows restores in the engine under the storage limit.

**Not verified yet**
- These have tests but have not been run in Wealthfolio by the author: the duplicate check, account linking, the wiped-account reset, the split price check, the failed-rows and push dialogs.
- A full push inside Wealthfolio after the storage fix; Update preview; the Securities editor; hover text.
- Daily sync, category fill-in and backup restore inside Wealthfolio.
- Inside Wealthfolio: the stepper, login polling against real Hosted Link sessions (the shape of `exit` and update-mode results is taken from Plaid's docs), dialogs, the save dialog, and the time input.
- Whether the Plaid investment `amount` includes fees. BUY and SELL rows omit `amount` to stay safe.
- Whether some Wealthfolio subcategory keys exist. A missing key falls back to its parent key, else the category is left unset.

## 7. Known limitations and future work

- **Mixing import paths:** the first push to an account is checked against what Wealthfolio holds (D41), but later CSV imports into the same account are not. The ledger knows only pushed rows. A row you delete by hand is not pushed again unless the whole account is empty (D44).
- **Discarded rows** stay discarded. There is no way yet to bring one back.
- **Cash openings** are not compared with earlier activity; only security openings are.
- **Card openings:** an unlinked opening TRANSFER_OUT on a credit card may count as spending. Check it after the first push.
- **Removing a connection** deletes its token. Back up first if you may want it again: a new connection costs a Plaid connection.
- **Not yet in the addon:**
  - A security Wealthfolio has no market data for fails its rows; choose Price from activities or Follow ticker for it.
  - Linking share transfers Wealthfolio can match by asset and quantity, and marking the remaining one-sided transfers external (`isExternal`).
  - A dry-run note for securities priced only from activities.
- **Future work:** HSA and 529 importers from CSV exports; cash reconciliation for bank accounts.
