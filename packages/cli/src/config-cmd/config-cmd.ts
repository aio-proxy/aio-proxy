import { spawn } from 'node:child_process';

import { AtomicConfigFile, configPath, parseRuntimeConfig } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import { redactSecrets } from '@aio-proxy/server';

import { ConfigValidationError } from '../errors';

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
  const raw = await new AtomicConfigFile(resolved).read();
  try {
    parseRuntimeConfig(raw);
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
  // Hand the raw file to the editor so comments/formatting survive — we never
  // rewrite the file ourselves (that would strip JSONC comments).
  spawn(editor, [path], { stdio: 'inherit' });
}
