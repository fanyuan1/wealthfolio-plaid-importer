# 0025 — D23: Institution quirks

## Context
Found in real data; each has a test (2026-11-06 to 2026-11-07)

## Decision
Stock plan: a share transfer with no cash goes out (Schwab journals); shares on a cash row are an RSU vest, TRANSFER_IN at that day's close. A cash journal tagged with a security is a cash transfer. A 401(k) `buy/contribution` is a TRANSFER_IN. A "partially filled" order uses amount ÷ price. 401(k) same-day out-and-back pairs are dropped. Merrill's zero-quantity reinvestment memo is dropped when a fill with the same amount is within 7 days. A Bilt card's rent charge plus same-day credit is dropped Merrill reposting a row is dropped like a 401(k) out-and-back pair. A share transfer with no price (Merrill journals, broker-to-broker moves) is priced at that day's close, so the cost basis is known. Bilt: the credit is "Payment - Bilt Housing" of the same amount, and the money leaves the bank as "BILT CARD HOUSING". The card pair nets to zero and would count the rent twice. Plaid can also tag the bank side of a Bilt card payment ("BILT CARD PMT") as rent; it is a card payment.

## Consequences
None recorded beyond the decision.
