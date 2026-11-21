# 0025 — D23: Institution quirks

## Context
Found in real data; each has a test (2026-11-06 to 2026-11-07)

## Decision
Stock plan: a share transfer with no cash goes out (Schwab journals); shares on a cash row are an RSU vest, TRANSFER_IN at that day's close. A cash journal tagged with a security is a cash transfer. A 401(k) `buy/contribution` is a TRANSFER_IN. A "partially filled" order uses amount ÷ price. 401(k) same-day out-and-back pairs are dropped. Merrill's zero-quantity reinvestment memo is dropped when a fill with the same amount is within 7 days. A Bilt card's rent charge plus same-day credit is dropped

## Consequences
None recorded beyond the decision.
