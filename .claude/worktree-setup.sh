#!/bin/sh
# Mirrors .codex/environments/environment.toml [setup].
# Runs at session start; cwd is the worktree (or the main checkout).
set -e

# Per-worktree git dir: the marker dies with the worktree and is never committed.
marker="$(git rev-parse --path-format=absolute --git-dir)/aio-proxy-setup-done"
[ -f "$marker" ] && exit 0

# The main checkout owns the shared, gitignored dev state. In a worktree the
# common dir is <main>/.git; in the main checkout it is the same path.
src="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

for d in .reference .aio-proxy-dev; do
  if [ -d "$src/$d" ] && [ ! -e "$d" ]; then
    ln -s "$src/$d" "$d"
  fi
done

bun install
bun run build
if command -v codegraph >/dev/null 2>&1; then
  codegraph init
fi

: >"$marker"
echo "Worktree setup done: deps installed, packages built."
