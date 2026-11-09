# Using Plaid Importer

For people who use the addon: what each step does and how to handle what you see. For how the importer works inside and how to build it, see [GUIDE.md](GUIDE.md).

## Steps

1. **Setup:** pick Sandbox or Production, paste the Plaid client ID and secret.
2. **Connections:** enter the owner's initials and click **Connect** (Sandbox also has **Add a test bank**). Open the link in a browser, log in, and share every account. The page notices when you finish. Use **Reconnect** when Plaid asks for a new login. Click the initials to fix a typo: accounts not yet created in Wealthfolio get the new name.
3. **Accounts:** turn on the accounts to sync. **Previous account** offers existing Wealthfolio accounts of the same type that no other row uses, closest name preselected, or **New**. After Create, **Change** undoes a link until the first push to that account. **Created** and **Spend tracking** show the state of the account each row will use. New accounts use transaction tracking. Turn on spending in Wealthfolio → Settings → Spending for bank and card accounts; the addon can't, and warns if it's off. Rows pushed without it get categories on a later sync once it is on.
4. **Sync:** **Dry run**, review, **Push to Wealthfolio**. Keep Wealthfolio open until a push finishes. Rows Wealthfolio refuses are shown with its reason and stay in the preview; their security moves to Needs attention. Fix it, **Update preview**, and push again. A dry run reuses the Plaid pull for 15 minutes; **Pull fresh from Plaid** gets a new one.
5. **Daily sync:** runs once a day after a set time while Wealthfolio is open. It stops and reports when a decision is needed: possible duplicates, a security to review, a moved ticker, refused rows, or a connection to reconnect. While it runs, changes in the addon wait for it to finish. The step shows the last run per account and the last 7 runs. **Run now** starts one at once. The switch does not sync to paired devices. If the run reports to-do items, Sync lists them. To-do items are notes, such as a holding that differs from Plaid; they do not stop the sync.
6. **Backup:** the **full backup** (recommended) holds connections and their access tokens, account selections, sync settings, transaction records already pushed to Wealthfolio, and Discard decisions. The **connections backup** holds only connections and their access tokens: after a restore, turn the accounts on again in Accounts and review the securities in Sync. To restore, paste a backup or choose its file, then **Restore**. Restore keeps what is here and fills in the rest; **Overwrite…** replaces it with the backup and removes connections the backup does not have, after a second confirmation. Anyone with the access tokens and your Plaid client ID and secret can read your account data. Backups do not hold the Plaid keys, but keep them in a password manager.

Start in a Sandbox profile (create a separate one in Wealthfolio), then repeat with the Production secret in your real profile. Back up your Wealthfolio data before the first Production push.

## Securities

After a dry run, **Securities** checks each ticker with Wealthfolio. Matching tickers, and plain currency cash such as `CUR:USD`, are listed under **Matching**; the rest under **Needs attention** (**Review**, then **Change** once saved). Push stays off until none are left.

| Option | Use it when |
|---|---|
| Automatic | Plaid's ticker works (default). |
| Input ticker | Plaid's ticker is missing or wrong. Checked live; Wealthfolio suggests spellings it knows. |
| Follow ticker | A fund with no quotes (401(k) trust) follows one that has them, at a ratio from your institution's price. Uses the closest date if Yahoo has no close. |
| Price from activities | No quotes; value changes only with activities. |
| Cash | A sweep or money-market fund that should count as cash. |
| Money Market Fund | A money-market fund kept as a position. |
| Leave out | A duplicate, e.g. a brokerage window also linked directly. |

You can change a security after a push. If it starts to be imported (from Cash or Leave out), the next dry run pulls the account's full history to add its older rows. If pushed rows no longer fit (another ticker, Cash or Leave out), Sync asks you to delete them first; the next push imports them again as set.

## Check for duplicates

The first push to an account lists every row Plaid would add, newest first. Matching runs after securities are mapped.

| Group | Meaning | Starts as |
|---|---|---|
| New | No similar activity in Wealthfolio | Add |
| Similar | Same day and amount, different type name; or an opening position whose shares differ from what Wealthfolio holds | Discard |
| Exact | Same day, ticker and amount. Shares transferred in match any activity with the same shares that day. An opening position is Exact when earlier activities already hold the same shares. | Discard |

Choose **Add** or **Discard** per row or per selection. Rows keep their place. **Compare** shows both versions. An opening position is compared with the account's earlier activity in that ticker.

New rows start as Add. Exact and Similar rows start as Discard, are remembered, and stop the daily sync until you decide. Rows that Wealthfolio already holds with their `plaid:<id>` note (pushed by this addon before, for example before a restore) are linked back without asking, and are not listed. If you delete all of an account's activities, the next dry run resets it and pulls everything again.

## Customize

Change the importer when an institution does something for every customer; fix one-off rows or payees in Wealthfolio (rules, edits). A coding agent such as [Claude Code](https://claude.com/claude-code) can make changes in this repo.

| Change | Where |
|---|---|
| Which accounts sync | Accounts tab |
| A security's ticker or pricing | Sync → Securities |
| Plaid → Wealthfolio category | `src/importer/categories.ts` |
| Institution row mapping | `src/importer/mapInvestments.ts`, `mapTransactions.ts` (add a test) |

After a code change, rebuild and reinstall the zip.

Example prompts:

- "Many 'trade with zero quantity' reviews on one broker. Wrong column might be used."
- "Rent shows twice in spending (Bilt card and bank). Do not count."

## After import

Wealthfolio's own tools take over; an agent over MCP can help.

Example prompts:
- List the highest recurring line items for other income, self-employment, uncategorized income, other expenses and uncategorized expenses.
- Correct and set up rules: ABC Bank Wire -> Rental Income; APA Treas Misc Pay -> Tax Refund

Notes on Wealthfolio's spending:

- A saved rule doesn't change old rows; re-run the rules on uncategorized rows. The addon does this after each push that adds rows.
- Give rules a priority above 90, or the built-in presets win.
- A row counts as Savings only when it's a linked transfer to an account outside spending. A transfer to an unlinked account stays an expense; give it an expense category instead.
