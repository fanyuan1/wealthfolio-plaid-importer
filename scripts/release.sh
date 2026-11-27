#!/usr/bin/env bash
set -euo pipefail

version=$(node -p "require('./package.json').version")
tag="v$version"

[ "$(git branch --show-current)" = main ] || { echo "Release from main."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first."; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || git push origin main

git tag "$tag"
git push origin "$tag"

run=""
for _ in $(seq 30); do
  run=$(gh run list --workflow release.yml --branch "$tag" --limit 1 --json databaseId -q '.[0].databaseId')
  [ -n "$run" ] && break
  sleep 2
done
[ -n "$run" ] || { echo "No Release workflow run found for $tag."; exit 1; }
gh run watch "$run" --exit-status

rm -f dist/*.zip dist/addon.js
gh release download "$tag" --dir dist
echo "Released $tag. dist/ holds the published zip:"
ls dist/*.zip
