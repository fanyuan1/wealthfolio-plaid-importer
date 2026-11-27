#!/usr/bin/env bash
set -euo pipefail

out=${1:-dist}
name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
pnpm exec vite build --outDir "$stage/dist" --emptyOutDir
cp manifest.json README.md "$stage/"

mkdir -p "$out"
rm -f "$out"/*.zip
zip_path="$(cd "$out" && pwd)/$name-$version.zip"
(cd "$stage" && zip -qr "$zip_path" manifest.json dist/addon.js README.md)
echo "Wrote $out/$name-$version.zip"
