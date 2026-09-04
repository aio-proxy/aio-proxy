#!/bin/sh
# Mirrors .codex/environments/environment.toml [setup].
# Runs at session start; cwd is the worktree (or the main checkout).
set -e

[ -d node_modules ] && exit 0

src="${CLAUDE_PROJECT_DIR:-.}"
for d in .reference .aio-proxy-dev; do
  if [ -d "$src/$d" ] && [ ! -e "$d" ]; then
    ln -s "$src/$d" "$d"
  fi
done

bun install
bun run build
command -v codegraph >/dev/null 2>&1 && codegraph init

echo "Worktree setup done: deps installed, packages built."
