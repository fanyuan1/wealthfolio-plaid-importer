# 0001 — D33: Split large addon-storage values into content-hashed parts

## Context
Wealthfolio syncs addon storage across devices and caps each value at about 250 KB. The ledger is bigger than that.

## Decision
`src/engine/store.ts` splits big values into parts of 50,000 characters (3 bytes each at most in UTF-8, with room for escaping). A part's key is its content hash, so unchanged parts are not written again. The head that lists the parts is written last.

## Consequences
A failed save leaves the old value whole. A save writes only the changed parts and the head.
