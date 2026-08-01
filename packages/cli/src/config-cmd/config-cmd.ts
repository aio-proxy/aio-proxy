import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AtomicConfigFile, configPath, parseRuntimeConfig } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import { redactSecrets } from '@aio-proxy/server';

import { ConfigValidationError } from '../errors';
import { CliExit, EXIT } from '../exit';
import { DEFAULT_CONFIG } from '../run';
import { loadServiceEnv } from '../service-env';

export type ConfigShowOptions = { readonly json?: boolean };

export async function configShow(
  _options: ConfigShowOptions = {},
  print: (line: string) => void = console.log,
): Promise<void> {
  const path = configPath();
  const raw = await new AtomicConfigFile(path).read();
  print(JSON.stringify(redactSecrets(raw), undefined, 2));
}

export async function configValidate(
  path: string | undefined,
  print: (line: string) => void = console.log,
): Promise<void> {
  const resolved = path ?? configPath();
  try {
    // `run` loads service.env before parsing, so a template referencing a var
    // defined only there resolves at runtime. Mirror that here or validate would
    // falsely reject a config that `run` accepts.
    loadServiceEnv(resolved);
    parseRuntimeConfig(await new AtomicConfigFile(resolved).read());
  } catch (cause) {
    throw new ConfigValidationError(
      m['cli.config.invalid']({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
  }
  print(m['cli.config.valid']({ path: resolved }));
}

export function configPathCommand(print: (line: string) => void = console.log): void {
  print(configPath());
}

// Split an `$EDITOR`/`$VISUAL` string into argv. A configured editor commonly carries
// arguments (`code --wait`) or a quoted path with spaces (macOS `"/Applications/Visual
// Studio Code.app/.../code" --wait`); spawning the whole string as one filename would
// fail with ENOENT. Handles single/double quotes and backslash escapes; no shell runs,
// so nothing in the value is interpreted as a shell metacharacter.
export function parseEditorCommand(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let hasToken = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) current += command[++i];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
    } else if (char === '\\' && i + 1 < command.length) {
      current += command[++i];
      hasToken = true;
    } else if (char === ' ' || char === '\t') {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

export async function configEdit(): Promise<void> {
  const configured = process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'vi';
  const [editor, ...editorArgs] = parseEditorCommand(configured);
  const path = configPath();
  // On a fresh install `~/.aio-proxy` does not exist yet, so the editor would
  // have nowhere to save. Create the dir (and seed the default config) before
  // launching. We only bootstrap when the file is absent, so an existing file's
  // comments/formatting survive untouched — we never rewrite it ourselves.
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, undefined, 2)}\n`, { mode: 0o600 });
  }
  // A whitespace-only `$EDITOR` parses to nothing; fall back to vi. Await the
  // editor and propagate a nonzero exit (e.g. `EDITOR=false` or the editor
  // failing to open the file) instead of reporting success while nothing was
  // edited. stdio inherit keeps the editor interactive on the terminal.
  const proc = Bun.spawn([editor ?? 'vi', ...editorArgs, path], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new CliExit(EXIT.unrecoverable, m['cli.config.edit_failed']({ editor: editor ?? 'vi', code }));
}
