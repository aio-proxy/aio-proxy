#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the aio-proxy Bun monorepo.
# Runs after the repository is checked out; safe to run repeatedly.
set -euo pipefail

# Pin Bun to the version the repo requires (see package.json `packageManager`/`engines`).
BUN_VERSION="1.3.14"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  echo "Installing Bun v${BUN_VERSION}..."
  curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"
fi
export PATH="$BUN_INSTALL/bin:$PATH"

# Pin a Node.js >= 22.18 ahead of the exec-daemon's bundled Node.
#
# oxlint loads oxlint.config.ts through Node and requires Node ^20.19 || >=22.18.
# The base image ships a compatible Node via nvm, but the Cloud Agent exec-daemon
# prepends its own older Node to PATH and can shadow it. Symlinking a compatible
# Node into $BUN_INSTALL/bin -- the directory that is always prepended to PATH
# wherever bun is available -- makes `node` deterministic for every shell and
# terminal without depending on nvm's PATH ordering.
node_is_compatible() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a>22||(a===22&&b>=18))?0:1)' >/dev/null 2>&1
}

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
pinned_node=""
for candidate in "$NVM_DIR"/versions/node/*/bin/node; do
  [ -x "$candidate" ] && node_is_compatible "$candidate" && pinned_node="$candidate"
done

if [ -z "$pinned_node" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null 2>&1 || true
  for candidate in "$NVM_DIR"/versions/node/*/bin/node; do
    [ -x "$candidate" ] && node_is_compatible "$candidate" && pinned_node="$candidate"
  done
fi

if [ -z "$pinned_node" ]; then
  echo "ERROR: could not resolve a Node.js >= 22.18 to pin on PATH." >&2
  exit 1
fi

node_bindir="$(dirname "$pinned_node")"
for tool in node npm npx corepack; do
  [ -x "$node_bindir/$tool" ] && ln -sf "$node_bindir/$tool" "$BUN_INSTALL/bin/$tool"
done

echo "bun $(bun --version)"
echo "node $("$BUN_INSTALL/bin/node" --version) (pinned -> $pinned_node)"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Install workspace dependencies exactly as pinned by the committed lockfile.
bun install --frozen-lockfile
