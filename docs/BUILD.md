# Plaid Importer: goal, research and build record

This records the goal, the facts relied on, and what was built. Decisions are in [DECISIONS.md](DECISIONS.md). Dates are absolute. Initial design and build: 2026-11-05.

## 1. Goal

Pull financial data from Plaid into Wealthfolio 3.12, inside the app, as a Wealthfolio addon that works on every surface Wealthfolio runs addons on. No terminal, no second program, and no data outside Wealthfolio except calls to Plaid and Yahoo Finance.

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
  - `secrets` (Wealthfolio's secret store; never synced), `storage` (string values, ~250 KB each, replicated to paired devices), `files.openSaveDialog` (a save dialog, or a download on the web), `network.request` only to `network.allowedHosts` in the manifest. `toast`, `query`, `logger` and `storage` need no permission.
  - The addon page runs in a frame that cannot open windows or show Plaid's Link iframe.
  - Install: Settings → Add-ons → Install from file (zip with `manifest.json` and `dist/addon.js`).
- **Profiles:** Wealthfolio has profiles. Use one for Sandbox.

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
  store.ts            addon storage in parts (D33), secrets, settings
  engine.ts           connections, accounts, dry run, push, daily sync, repairs, backup
  writer.ts           Writer over the addon SDK (D32)
src/ui/               the six steps: setup, connections, accounts, sync (with securities, matches and daily sync), backup; page and shared pieces
src/index.tsx         registers the page and the daily sync timer
test/importer/        mapping, account naming, multi-run plan + push with a fake Wealthfolio
test/engine/          storage parts, backup, daily sync, repairs, writer
test/boundary.test.ts src/importer imports neither the SDK nor React
test/e2e/             Playwright against Wealthfolio in Docker, with a fake Plaid
test/docker/          the compose file and zip install for the dev and test Wealthfolio
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

## 6. Verified vs not verified (2026-11-09)

**Verified**
- vitest: 114 tests (mapping, naming, matching against existing activities, split prices, multi-run plan + push with a fake Wealthfolio, storage parts under the size limit, both backup kinds, merge and overwrite restore, initials, login polling, progress events, daily sync time, switch, lock and history, daily sync rules, changes refused while it runs, securities review, securities changes after a push, category fill-in, writer). `tsc` is clean, also with unused-code checks.
- Playwright against Wealthfolio 3.12.0 in Docker, with a fake Plaid: the addon starts with Wealthfolio, keys, Hosted Link connect, account creation, Securities review (currency cash automatic, a money market fund reviewed), dry run, push, a second push with only the new row, and the daily sync running with the addon page never opened.
- Plaid Sandbox through the core: Hosted Link returns a URL; a 1,013-row plan.
- Inside Wealthfolio, Sandbox profile: install, keys, connections, Accounts, Dry run, and Push reaching `saveMany` (it found the `checkImport` symbol rule and the storage size limit, both fixed).
- A real backup of 14 connections and 4,374 pushed rows restores in the engine under the storage limit.

**Not verified yet**
- These have tests but have not been run in Wealthfolio by the author: the duplicate check, account linking, the wiped-account reset, the split price check, the failed-rows and push dialogs.
- A full push inside Wealthfolio after the storage fix; Update preview; the Securities editor; hover text.
- Category fill-in and backup restore inside Wealthfolio.
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
