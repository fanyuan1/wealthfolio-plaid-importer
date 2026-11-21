# 0018 — D16: Options

## Context
Wealthfolio prices options per share with a contract multiplier

## Decision
OCC compact symbol from `ticker_symbol` or `option_contract`; instrument type OPTION; Plaid's quantity (single options) ÷ multiplier 100; POSITION_OPEN/POSITION_CLOSE subtypes; holdings scaled the same way. A derivative the user maps to a ticker that is not an OCC symbol is that stock: EQUITY, multiplier 1. A Robinhood ANT buy came under a derivative security mapped to ANT; as an option it turned 42 shares into 0.42 contracts and left the rest to the opening position (2026-11-21). A partial fill is measured in Plaid's units, before the multiplier

## Consequences
None recorded beyond the decision.
