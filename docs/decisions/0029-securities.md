# 0029 — D27: Securities

## Context
Plaid often has no ticker for 401(k) trusts and 529 units; the user picks the spelling Wealthfolio accepts (2026-11-07)

## Decision
Automatic: Plaid's ticker plus the exchange suffix (`.TO`), `BTC-USD` for crypto, OCC for options. Sync → Securities sets one per security: Input ticker, Follow ticker (D28), Price from activities (manual quotes), Cash, Money Market Fund (a holding), Leave out. Automatic is not offered when it gives no symbol. Each option has a hover explanation. Before the list shows, every automatic ticker is checked with Wealthfolio's ticker search (exact symbol match); the table appears when all checks are done, so rows do not move. Matching holds the tickers that match and that Wealthfolio can look up, and Plaid's currency cash (`CUR:` plus an ISO 4217 code, such as `CUR:USD`), which is always cash; Needs attention holds the rest, including cash-like funds (Review, then Change once saved). Input ticker is checked as you type. When Wealthfolio does not know a ticker, it shows the symbols the search returned. The addon does not rewrite Plaid's tickers (BRK.B stays BRK.B) A ticker lookup that fails counts as "could not check", not as unknown. Results are cached for the session. Plaid files some crypto as type cash or other (ticker CUR:BTC), or flags it cash-equivalent: it is still crypto. It sends BTC, CUR:BTC or an already paired BTC-USD; all become the BTC-USD pair. A fund with no ticker gets a stable made-up symbol, such as TARGET2050CIT-1A2B. A failed live lookup in the security editor does not block the user.

## Consequences
None recorded beyond the decision.
