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
- Plaid removals delete the Wealthfolio activity. Plaid edits update it. Categories are set once, at import, so your own changes stay. The ledger keeps Plaid's category with each row, so a row left without one gets it after a later push, with no new pull.
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
| Plaid client ID, secrets, access tokens, the daily sync switch | Addon secrets, through the addon SDK: Wealthfolio's secret store. Never synced to other devices |
| Connections, account and securities settings, ledger, cached prices, last sync | Addon storage, one set per Plaid environment |

Addon storage caps each value at about 250 KB, so large values are split into parts (D33). Step 6, **Backup**, writes all of it, with the tokens, as one JSON file.

## Code layout

- `src/importer/`: the pure importer: mapping, planner, push, Plaid client, prices and naming. It imports neither the addon SDK nor React; `test/boundary.test.ts` fails if it does.
- `src/engine/`: everything without React: storage, connections, dry run, push, daily sync, repairs. `writer.ts` writes through the addon SDK.
- `src/ui/`: the six steps. `src/index.tsx` registers the page and the daily sync timer.

See DECISIONS.md section 5.1 for each file.

### Styling

The addon runs on every surface Wealthfolio runs on, phones included, and gets Wealthfolio's stylesheet. That stylesheet holds only the Tailwind classes Wealthfolio's own code uses.

- Use a class only if Wealthfolio uses it. Use the logical forms: `ms-auto`, `me-2`, `ps-6`, `text-end`, not `ml-auto`, `mr-2`, `pl-6`, `text-right`.
- Do not add a margin to an icon in a button. The button spaces its content with `gap-2`.
- Wealthfolio gives every `.flex` and `.grid` `overflow-x: hidden`. Content that sticks out, such as a switch's touch area, then makes the row scroll, and a button row that does not fit hides a button. Use `SWITCH_ROW` (an `inline-flex` row) for a switch and its label, and `ACTIONS` for a card's buttons: stacked on a phone, in a row from `sm` up. Both are in `src/ui/common.tsx`.
- Let wide tables scroll sideways: give long cells a minimum width (`min-w-56`) or `whitespace-nowrap`.

The browser tests check the first and third rules: every class in `src/ui` must be in the loaded stylesheet, and a phone-width run must show no stray scroll areas.

## Build and test

You need Node.js 22 and pnpm.

1. Run `pnpm install`.
2. Run `npx tsc --noEmit` and `pnpm test`. Both must pass.
3. Run `pnpm bundle`. It writes `dist/plaid-importer-<version>.zip`. `dist/` is not tracked.
4. Install the zip in a Wealthfolio Sandbox profile, and run a dry run and a push with the test bank.

### Browser tests (Docker)

The browser tests run the addon in a real Wealthfolio server in Docker, with Playwright. They need Docker running (on macOS: `brew install colima docker docker-compose`, then `colima start`).

1. Run `pnpm exec playwright install chromium` once.
2. Run `pnpm test:e2e`. It builds the zip, starts a new Wealthfolio for each test on port 18088, and removes it at the end. Set `E2E_KEEP=1` to keep the last one.

Without Docker the browser tests are skipped. They do not call Plaid: Wealthfolio's server only reaches public HTTPS hosts, so the tests answer the addon's network calls in the browser with a fake Plaid (`test/e2e/fake-plaid.ts`). It has one bank with checking, a card and a brokerage, and it fails on any endpoint it does not know.

To try the addon by hand in Docker:

1. Run `pnpm wf:up`. Open http://127.0.0.1:8090. It has no password and listens on this computer only. Use Sandbox keys, not real banks.
2. Run `pnpm wf:install` after each change. It builds the zip and installs it. Reload the page.
3. Run `pnpm wf:down` to stop it, or `pnpm wf:reset` to delete its data.

The daily sync runs only while Wealthfolio is open: the timer is in the addon, not in a background service. Here that means a browser tab. The on/off switch is a secret, so it applies to every browser that opens this server. When several are open, only one runs it.

The CI workflow (`.github/workflows/ci.yml`) runs the type check, tests and bundle on every push and pull request, and the browser tests in a second job. Pushing a `vX.Y.Z` tag runs the Release workflow, which publishes the zip as a GitHub release (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
