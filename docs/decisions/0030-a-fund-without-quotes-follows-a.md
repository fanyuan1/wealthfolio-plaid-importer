# 0030 — D28: A fund without quotes follows a ticker

## Context
Wealthfolio's market data has no indexes; uploading daily quotes was rejected (2026-11-06)

## Decision
`track: {symbol, date, price, close, ratio}`, ratio = fund price ÷ the ticker's close on that day (Yahoo Finance, or typed); when that day has no close, the closest day with one is used and shown. Plaid rows are rewritten in the ticker's units (quantity × ratio, price ÷ ratio, amounts unchanged), so Wealthfolio prices it daily. Accounts holding a tracked fund get full history each pull and their opening positions computed again, so a new ratio updates pushed quantities, openings included

## Consequences
None recorded beyond the decision.
