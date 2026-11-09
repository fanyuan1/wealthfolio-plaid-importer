# Plaid Importer for Wealthfolio

A [Wealthfolio](https://github.com/afadil/wealthfolio) addon that imports bank, card and brokerage data from [Plaid](https://plaid.com).

Wealthfolio is a local-first app for investments and spending, with no bank connections. This addon pulls accounts, transactions and holdings from Plaid, maps them to Wealthfolio activity types and spending categories, and pushes them after a dry run. It creates accounts or links existing ones, and checks new rows against data already in Wealthfolio (CSV imports, earlier links) so nothing is added twice.

Network access is limited to Plaid and Yahoo Finance (prices Plaid doesn't send). Hosts are listed in `manifest.json`.

> **Status:** personal project. Tested with Wealthfolio 3.12 on macOS in a Sandbox profile and a personal profile, and on the self-hosted server (Docker) with automated browser tests. Expect rough edges with institutions it hasn't seen.

## Requirements

- Wealthfolio 3.12+, on any surface that runs addons
- A [Plaid](https://dashboard.plaid.com/signup) account. Sandbox is free; Production needs approval, and the free Trial plan caps institution connections. Removed connections still count, and Plaid has no API for the count, so check the dashboard.

## Install

1. Download `plaid-importer-<version>.zip` from the [latest release](https://github.com/fanyuan1/wealthfolio-plaid-importer/releases/latest), or build it yourself (`pnpm install && pnpm bundle`; see [docs/GUIDE.md](docs/GUIDE.md)).
2. Settings → Add-ons → Install from file. Approve the permissions.

To update, install the zip from the newer release. See the [changelog](CHANGELOG.md).

## Usage

1. **Setup:** pick Sandbox or Production and paste the Plaid client ID and secret.
2. **Connections:** enter the owner's initials, click **Connect**, and log in through the link. The page notices when you finish.
3. **Accounts:** turn on the accounts to sync, and pick an existing Wealthfolio account or **New** for each.
4. **Sync:** run **Dry run**, review it, then click **Push to Wealthfolio**.
5. **Daily sync:** runs once a day after a set time while Wealthfolio is open, and stops to ask when a decision is needed.
6. **Backup:** make a full backup (recommended) or a connections backup, or restore one.

> **Back up your Wealthfolio data before the first Production push.** A push adds, updates and deletes activities it created. Rows you edited, or that existed before, are never changed. Try a Sandbox profile first.

Details: [docs/USAGE.md](docs/USAGE.md).

## Privacy

- Plaid keys and access tokens live in Wealthfolio's secret store, which never syncs to other devices.
- Settings and the push record live in Wealthfolio's addon storage and sync with its device sync; tokens don't.
- Plaid receives `plaid-importer-<initials>` as the user id, not your name or email.
- Backups contain access tokens, not the Plaid keys. Anyone with the access tokens and your Plaid client ID and secret can read your account data. Delete copies you no longer need.

## Docs

- [CHANGELOG.md](CHANGELOG.md): what each release adds.
- [docs/USAGE.md](docs/USAGE.md): using the addon: each step, securities, duplicate check, customizing, after import.
- [docs/GUIDE.md](docs/GUIDE.md): how it works inside: mapping rules, data storage, code layout, build and test.
- [docs/DECISIONS.md](docs/DECISIONS.md): what was decided and why. Read before changing behavior.
- [docs/GLOSSARY.md](docs/GLOSSARY.md): the terms the code and docs use.
- [CONTRIBUTING.md](CONTRIBUTING.md): issues and pull requests.

## License

[MIT](LICENSE). Not affiliated with Plaid or Wealthfolio.
