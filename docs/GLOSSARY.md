# Plaid Importer

A Wealthfolio addon that brings bank, card and brokerage data from Plaid into Wealthfolio.

## Language

**Connection**:
One login at one institution, held as a Plaid Item and its access token. One connection covers many accounts.
_Avoid_: Item (in the UI), account token, link

**Owner**:
The person a connection belongs to, written as up to four initials.
_Avoid_: User, person, holder

**Account**:
One Plaid account inside a connection, and the Wealthfolio account it is linked to.
_Avoid_: Connection

**Ledger**:
The record of transaction rows already pushed to Wealthfolio, the user's Discard decisions, and the sync position of each connection.
_Avoid_: Log, history

**Sync settings**:
How each security maps to Wealthfolio: its ticker, a followed ticker and ratio, cash, or left out.
_Avoid_: Security settings, sync choices

**Connections backup**:
Connections and their access tokens, nothing else.
_Avoid_: Token backup

**Full backup**:
Connections and their access tokens, account selections, sync settings, and the ledger. The recommended backup.
_Avoid_: Backup (unqualified)
