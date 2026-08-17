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

echo "bun $(bun --version)"
echo "node $(node --version)"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Install workspace dependencies exactly as pinned by the committed lockfile.
bun install --frozen-lockfile
