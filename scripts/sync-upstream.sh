#!/usr/bin/env bash
# Re-vendor packages/core from lessweb/deepcode-cli at <ref> (default: main).
set -euo pipefail
ref="${1:-main}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
git clone --quiet https://github.com/lessweb/deepcode-cli "$tmp/up"
git -C "$tmp/up" checkout --quiet "$ref"
dst="$(dirname "$0")/../vendor/deepcode-core"
rm -rf "$dst/src" "$dst/templates"
cp -r "$tmp/up/packages/core/src" "$tmp/up/packages/core/templates" "$dst/"
rm -rf "$dst/src/tests"
cp "$tmp/up/LICENSE" "$dst/LICENSE"
sha="$(git -C "$tmp/up" rev-parse HEAD)"
ver="$(node -p "require('$tmp/up/packages/core/package.json').version")"
sed -i -E "s#tree/[0-9a-f]+/#tree/$sha/#; s#^- Version: .*#- Version: $ver (commit \`$sha\`)#" "$dst/UPSTREAM.md"
for p in "$dst/../patches/"*.patch; do patch -s -d "$dst" -p1 < "$p" || { echo "patch failed: $p"; exit 1; }; done
echo "vendored deepcode-core $ver @ $sha; check dependency versions in package.json against upstream packages/core/package.json"
