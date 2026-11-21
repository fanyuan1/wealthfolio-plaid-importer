# 0048 — D47: Releases

## Context
Users download a built zip instead of building; a tag cannot ship a mismatched version (2026-11-07)

## Decision
A `vX.Y.Z` tag runs a GitHub Actions workflow that checks the tag against `manifest.json` and `package.json`, runs the type check and tests, builds the zip and publishes a release. `dist/` is not tracked. CI runs the same checks on every push and pull request

## Consequences
None recorded beyond the decision.
