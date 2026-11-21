# 0058 — D57: Feedback in place

## Context
Messages that came and went moved the controls next to them, so the screen jumped (2026-11-09)

## Decision
A success shows on the control that caused it, for a moment: the button fades into a green ✓ label (Copied, Saved, Added, Keys work), then back. Its width fits both labels. A control that saves on change shows the ✓ on itself (D49). Status that lasts (a running check, errors, results) goes below a section's buttons, never above its title. Nothing appears beside a control and pushes others aside A card's action buttons stack full width on a phone and sit in a row from the sm breakpoint up, because Wealthfolio's CSS clips an overflowing .flex row and would hide a button. A switch and its label use inline-flex, because the .flex rule's overflow-x: hidden made the switch's touch area scroll the row. A button that flashes a result needs a minimum width that fits both labels. The security editor keeps one line for the check result, so the dialog does not grow and shrink while you type. A button stays enabled while it shows its ✓ label, so the label is not dimmed; a click then does nothing.

## Consequences
None recorded beyond the decision.
