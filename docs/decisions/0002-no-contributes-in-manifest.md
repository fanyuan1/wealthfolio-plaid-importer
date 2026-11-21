# 0002. The manifest declares no `contributes`

## Context
Wealthfolio boots an addon that has contributed routes only when its page is first opened. The daily sync timer must run from startup.

## Decision
`manifest.json` declares no `contributes`. `src/index.tsx` registers the route and the sidebar item in `enable`, and starts the daily sync timer there.

## Consequences
The addon starts with Wealthfolio, not on the first visit. `test/e2e/startup.spec.ts` guards this.
