#!/bin/sh
# Builds dsh as one native binary with Tov (https://tov.sh): ./dsh-native (or $1).
# Needs node (for esbuild), npm dependencies installed, and tov on PATH.
set -eu
cd "$(dirname "$0")/.."
DSH_BINARY=1 node scripts/build.mjs
mkdir -p tov/node_modules
ln -sfn ../../dist tov/node_modules/dsh-dist
tov build tov/dsh.tov -o "${1:-dsh-native}"
