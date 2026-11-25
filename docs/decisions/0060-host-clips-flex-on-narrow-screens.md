# 0060 — D59: Wealthfolio clips flex boxes on narrow screens

## Context
Wealthfolio's stylesheet sets `overflow-x: hidden` on every `.flex` and `.grid` at widths up to 1024px. A box with hidden overflow is a scroll container, and a scroll container in a flex column can shrink below its content. On phones, in both mobile and desktop mode, the progress rows shrank and each row scrolled on its own (2026-11-24).

## Decision
A list that scrolls stacks its rows in normal block flow, not in a flex column. The rows can keep `flex` for their own content, because block flow never shrinks them.

## Consequences
The browser test "progress rows keep their height" runs at a 412px viewport, so the host rule applies.
