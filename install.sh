#!/bin/sh
# Installs dsh from npm into its own prefix and links it into a directory on PATH.
#   curl -fsSL https://raw.githubusercontent.com/coderbuzz/dsh/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 0.1.2 --bin-dir /usr/local/bin
# Options (or env): --version V (DSH_VERSION, default latest)  --prefix DIR (DSH_PREFIX, default ~/.local/share/dsh)
#                   --bin-dir DIR (DSH_BIN_DIR, default ~/.local/bin)  --uninstall  -h
# Env only: DSH_REGISTRY (default https://registry.npmjs.org), DSH_PACKAGE (tarball/dir instead of the registry; for tests).
set -eu

version="${DSH_VERSION:-latest}"
prefix="${DSH_PREFIX:-$HOME/.local/share/dsh}"
bin_dir="${DSH_BIN_DIR:-$HOME/.local/bin}"
registry="${DSH_REGISTRY:-https://registry.npmjs.org}"
package="${DSH_PACKAGE:-@coderbuzz/dsh@$version}"
uninstall=0

die() { echo "install.sh: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; version="$2"; package="${DSH_PACKAGE:-@coderbuzz/dsh@$2}"; shift 2 ;;
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; prefix="$2"; shift 2 ;;
    --bin-dir) [ $# -ge 2 ] || die "--bin-dir needs a value"; bin_dir="$2"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# npm sits next to node; on version-manager setups (fnm, nvm) it is not on PATH when the shell is non-interactive,
# so look beside the real node binary too.
node_bin="$(command -v node 2>/dev/null || true)"
[ -n "$node_bin" ] || die "Node.js >= 22 is required (https://nodejs.org)"
node_real="$(readlink -f "$node_bin" 2>/dev/null || echo "$node_bin")"
PATH="$PATH:$(dirname "$node_real")"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] 2>/dev/null || die "Node.js >= 22 is required (found $(node -v))"
command -v npm >/dev/null 2>&1 || die "npm not found next to node ($node_real)"

if [ "$uninstall" = 1 ]; then
  npm rm -g --prefix "$prefix" @coderbuzz/dsh >/dev/null 2>&1 || true
  # Remove the link only if it points into our prefix; never touch an unrelated `dsh`.
  link="$bin_dir/dsh"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$prefix/bin/dsh" ]; then rm -f "$link"; fi
  rm -rf "$prefix"
  echo "dsh removed (prefix $prefix, link $link)."
  exit 0
fi

echo "Installing $package into $prefix ..."
npm install -g --prefix "$prefix" "$package" --registry "$registry" --no-audit --no-fund --loglevel=error \
  || die "npm install failed"

mkdir -p "$bin_dir"
link="$bin_dir/dsh"
if [ -e "$link" ] && [ ! -L "$link" ]; then die "$link exists and is not a symlink; remove it or pick --bin-dir"; fi
ln -sfn "$prefix/bin/dsh" "$link"

installed="$(node -p "require('$prefix/lib/node_modules/@coderbuzz/dsh/package.json').version" 2>/dev/null || echo '?')"
echo "Installed dsh $installed -> $link"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Note: $bin_dir is not on your PATH. Add this to your shell profile:"
     echo "  export PATH=\"$bin_dir:\$PATH\"" ;;
esac
echo "Set DEEPCODE_API_KEY (see README) and try:  dsh models"
