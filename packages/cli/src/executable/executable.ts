import { existsSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';

import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../exit';
import { resolveStableManagedExec } from '../upgrade';

// Resolve the single executable the service manager should launch. The npm
// `aio-proxy` bin on PATH is a Node shim (`#!/usr/bin/env node`) that spawns the
// platform-native binary; a managed run (launchd/systemd) has a minimal PATH
// without node, so pointing ExecStart at the shim fails before the real binary
// starts.
//
// A brew (or any symlinked) install instead exposes a stable launcher on PATH
// (`/opt/homebrew/bin/aio-proxy`) that symlinks to the *versioned* binary
// (`.../Cellar/aio-proxy/0.3.0/bin/aio-proxy`), which is also what execPath
// resolves to. Baking that versioned execPath is what breaks `service restart`
// after `brew upgrade`: brew deletes the old Cellar dir and retargets the
// symlink, leaving ExecStart pointing at a binary that no longer exists. So when
// the PATH launcher resolves to the same binary we're running as, prefer that
// stable path — it follows the symlink across upgrades.
//
// Otherwise fall back to the self-contained native binary we already ARE
// (execPath) — but only if it still exists. An in-process `aio-proxy upgrade` on
// brew deletes the old Cellar execPath mid-run while retargeting the launcher
// symlink to the new binary, so a now-deleted execPath must defer to the PATH
// launcher (the live install) instead of baking a path that no longer exists.
// Only when execPath is an interpreter (dev `bun run`) or gone do we resolve via
// PATH, failing fast if even that is missing rather than render `ExecStart=<bun>
// run`, which would invoke bun's own `run` subcommand and never start.
// which/execPath/realpath/exists are injectable to keep this testable.
// ponytail: no AVX2/musl variant probing like opencode — we ship one binary per
// platform with no variants, so execPath basename is enough.
export function resolveAgentExecutable(
  which: (name: string) => string | null = Bun.which,
  execPath: string = process.execPath,
  realpath: (path: string) => string = realpathSync,
  exists: (path: string) => boolean = existsSync,
): string {
  const sameBinary = (a: string, b: string): boolean => {
    try {
      return realpath(a) === realpath(b);
    } catch {
      return a === b;
    }
  };
  const onPath = which('aio-proxy');
  const resolved =
    onPath !== null && sameBinary(onPath, execPath)
      ? onPath
      : basename(execPath) === 'aio-proxy' && exists(execPath)
        ? execPath
        : onPath !== null
          ? onPath
          : undefined;
  if (resolved === undefined) throw new CliExit(EXIT.unrecoverable, m['cli.service.exec_not_found']());
  return resolveStableManagedExec(resolved);
}
