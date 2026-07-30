import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AtomicConfigFile, configPath, parseRuntimeConfig } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import { redactSecrets } from '@aio-proxy/server';

import { ConfigValidationError } from '../errors';
import { DEFAULT_CONFIG } from '../run';

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
    parseRuntimeConfig(await new AtomicConfigFile(resolved).read());
  } catch (cause) {
    throw new ConfigValidationError(
      m.cli_config_invalid({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
  }
  print(m.cli_config_valid({ path: resolved }));
}

export function configPathCommand(print: (line: string) => void = console.log): void {
  print(configPath());
}

export function configEdit(): void {
  const editor = process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'vi';
  const path = configPath();
  // On a fresh install `~/.aio-proxy` does not exist yet, so the editor would
  // have nowhere to save. Create the dir (and seed the default config) before
  // launching. We only bootstrap when the file is absent, so an existing file's
  // comments/formatting survive untouched — we never rewrite it ourselves.
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, undefined, 2)}\n`, { mode: 0o600 });
  }
  spawn(editor, [path], { stdio: 'inherit' });
}
