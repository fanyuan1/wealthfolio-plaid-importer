# 0019 — D17: Bank and card rows

## Context
Cash must reconcile; credits looked like card payments

## Decision
Every posted transaction becomes an activity (5.3), so the cash balance stays right. Card rewards and statement credits named CREDIT without PAYMENT are CREDIT, not payments

## Consequences
None recorded beyond the decision.
