# Plaid Importer technical guide

This guide is for people who want to understand the rules or change the code: mapping rules, where data is kept, code layout, build and test. For using the addon, see [USAGE.md](USAGE.md). Read [DECISIONS.md](DECISIONS.md) before you change behavior.

## Rules the importer applies

- Pending transactions are never imported.
- The first pull reads about 24 months. Later pulls re-read 14 days of investments. The ledger prevents duplicates. The first push to an account lists rows Wealthfolio may already have (see [USAGE.md](USAGE.md#check-for-duplicates)).
- Opening positions and cash balances are a TRANSFER_IN at the window start. The value comes from the Plaid cost basis, else the market close that day. After a later split the price is scaled to the shares held on the opening day.
- Sweep and money-market buys and sells are dropped, because they are cash. Choose Money Market Fund to keep a fund as a position.
- Transfers between linked accounts are matched within 3 days and linked as a pair. Legs that share a reference number pair first.
- Splits become a ratio. Mergers, spin-offs, exercises and assignments go to the to-do list.
- Options are imported as OCC symbols, in contracts, with POSITION_OPEN or POSITION_CLOSE.
- Plaid removals delete the Wealthfolio activity. Plaid edits update it. Categories are set once, at import, so your own changes stay.
- New opening rows use the shared history start of your accounts.
- A Plaid price on a trade from before a split that is already adjusted for it is scaled back, and the change is listed in the to-do list.

## Funds without a public quote

A 401(k) collective trust or a DAF pool has no ticker that Wealthfolio can price. Choose **Follow ticker** for it in Sync → Securities:

- ratio = the fund's price ÷ the ticker's close on the same day.
- quantity × ratio, price ÷ ratio. Amounts and cost basis do not change.

Wealthfolio has no index data, so pick an ETF such as `VOO`. If Yahoo has no close for the date you type, the closest date is used. Each dry run compares the ratio with the newest price your institution reports and proposes a new one. The daily sync applies a change of 5% or less; a bigger change waits for you.

## Brokerage windows

A retirement plan can hold part of its money in a self-directed brokerage window at another broker. If you link both, the money shows twice. The to-do list flags it as a possible duplicate. Choose **Leave out** for that security in Securities. If the plan reports it as its own account, turn that account off in Accounts.

## Where data is kept

| What | Where |
|---|---|
| Plaid client ID, secrets, access tokens, the daily sync switch | System keychain, through the addon SDK. Never synced to other computers |
| Connections, account and securities settings, ledger, cached prices, last sync | Addon storage, one set per Plaid environment |

Addon storage caps each value at about 250 KB, so large values are split into parts (D33). Step 6, **Backup**, writes all of it, with the tokens, as one JSON file.

## Code layout

- `src/importer/`: the pure importer: mapping, planner, push, Plaid client, prices and naming. It imports neither the addon SDK nor React; `test/boundary.test.ts` fails if it does.
- `src/engine/`: everything without React: storage, connections, dry run, push, daily sync, repairs. `writer.ts` writes through the addon SDK.
- `src/ui/`: the six steps. `src/index.tsx` registers the page and the daily sync timer.

See DECISIONS.md section 5.1 for each file.

## Build and test

You need Node.js 22 and pnpm.

1. Run `pnpm install`.
2. Run `npx tsc --noEmit` and `pnpm test`. Both must pass.
3. Run `pnpm bundle`. It writes `dist/plaid-importer-<version>.zip`. `dist/` is not tracked.
4. Install the zip in a Wealthfolio Sandbox profile, and run a dry run and a push with the test bank.

The CI workflow (`.github/workflows/ci.yml`) runs the type check, tests and bundle on every push and pull request. Pushing a `vX.Y.Z` tag runs the Release workflow, which publishes the zip as a GitHub release (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
