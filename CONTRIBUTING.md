# Contributing

Thank you for helping. The importer gets better with every institution it sees.

## Never share personal data

Plaid rows contain your account ids, masks, names and amounts. Before you open an issue or a pull request:

- Replace account ids, masks and names with made-up ones (`AB · Bank ••1234`).
- Change the amounts and share counts.
- Never include a backup, an access token or Plaid keys.

## Report a data quirk

1. Say which institution and account type it is.
2. Show the Plaid row, with the values changed as above.
3. Say what the addon imported, and what you expected in Wealthfolio.

## Change the code

1. Read [docs/DECISIONS.md](docs/DECISIONS.md). It says why the importer works the way it does.
2. Keep the change small. Match the style of the code around it.
3. Add a test with made-up values for each mapping change.
4. Add a row to the decision log when you change behavior.
5. Run the type check and tests (see [docs/GUIDE.md](docs/GUIDE.md)). They must pass.
6. If you changed sync or push, rebuild the zip and run it in a Wealthfolio Sandbox profile.
7. Leave the version alone in a pull request. The maintainer raises it at release (see below).

A fix for one row in one account belongs in Wealthfolio, not in the mapping.

## Release (maintainer)

1. Set the same `version` in `manifest.json` and `package.json` (semantic versioning). Wealthfolio keeps an installed addon of the same version.
2. Add a `## X.Y.Z - YYYY-MM-DD` section to `CHANGELOG.md`.
3. Commit both to `main`.
4. Run `git tag vX.Y.Z && git push origin vX.Y.Z`.

The Release workflow checks that the tag matches both versions, runs the type check and tests, builds the zip, and publishes a GitHub release. Its notes are the version's CHANGELOG section. A tag with a suffix, such as `v0.2.0-rc.1`, becomes a pre-release.
