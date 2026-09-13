import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

import type { GrokCompatReport } from './types';

export const HELPER_STDOUT_KEYS = ['access_token', 'expires_in'] as const;

export type DeviceVerification = {
  readonly url: string;
  readonly userCode: string;
};

type GrokCompatCase = GrokCompatReport['cases'][number];

const USER_CODE = /[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/u;
const VERIFY_URL = /https?:\/\/[^\s]+\/dashboard\/agents\/authorize[^\s]*/iu;

export function quoteCliArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseDeviceVerificationUrl(text: string): DeviceVerification | undefined {
  const match = VERIFY_URL.exec(text);
  if (match === null) return undefined;
  const url = match[0]!;
  const code =
    new URL(url.replace('#', '?')).searchParams.get('code') ??
    new URL(url.replace('#', '?')).searchParams.get('user_code') ??
    USER_CODE.exec(url)?.[0];
  if (code === null || code === undefined || !USER_CODE.test(code)) return undefined;
  return { url, userCode: code };
}

export function wrapAuthProviderCommand(
  configText: string,
  recorder: string,
  captureDir: string,
  launcher = process.execPath,
): string {
  const prefix = `${quoteCliArg(launcher)} ${quoteCliArg(recorder)} --capture ${quoteCliArg(captureDir)} -- `;
  return configText.replaceAll(
    /((?:^|\n)[ \t]*auth_provider_command\s*=\s*")((?:\\.|[^"])*)(")/gu,
    (full, start, value, end) => {
      if (typeof value !== 'string' || value.includes('--capture')) return full;
      return `${start}${prefix}${value}${end}`;
    },
  );
}

export async function readCapturedText(captureDir: string, name: 'stdout' | 'stderr'): Promise<string> {
  try {
    return await readFile(join(captureDir, name), 'utf8');
  } catch {
    return '';
  }
}

export async function waitForVerificationUrl(options: {
  readonly captureDir: string;
  readonly stderr: () => string;
  readonly timeoutMs: number;
  readonly finished?: () => boolean;
}): Promise<DeviceVerification> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const captured = await readCapturedText(options.captureDir, 'stderr');
    const found = parseDeviceVerificationUrl(captured) ?? parseDeviceVerificationUrl(options.stderr());
    if (found !== undefined) return found;
    if (options.finished?.() === true) break;
    await Bun.sleep(50);
  }
  throw new Error('device verification URL not found on helper stderr');
}

function failed(name: string, detail: string): GrokCompatCase {
  return { name, passed: false, detail };
}

export async function helperStdoutContractCase(captureDir: string, extraStderr = ''): Promise<GrokCompatCase> {
  const stdout = await readCapturedText(captureDir, 'stdout');
  const stderr = `${await readCapturedText(captureDir, 'stderr')}\n${extraStderr}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return failed('helper-stdout-contract', 'helper stdout was not JSON.parseable in memory');
  }
  if (!isPlainObject(parsed)) return failed('helper-stdout-contract', 'helper stdout was not a JSON object');
  const keys = Object.keys(parsed);
  if (keys.length !== HELPER_STDOUT_KEYS.length || keys.some((key, index) => key !== HELPER_STDOUT_KEYS[index])) {
    return failed('helper-stdout-contract', `helper stdout keys were ${JSON.stringify(keys)}`);
  }
  if (VERIFY_URL.exec(stderr) === null) {
    return failed('helper-stdout-contract', 'helper stderr did not contain the Dashboard login URL');
  }
  if (/aio_agent_|refresh_token/iu.test(stderr)) {
    return failed('helper-stdout-contract', 'helper stderr contained a token');
  }
  if (/refresh_token|aio_agent_rt_/iu.test(stdout)) {
    return failed('helper-stdout-contract', 'helper stdout contained a refresh token');
  }
  return {
    name: 'helper-stdout-contract',
    passed: true,
    detail: 'in-memory JSON.parse keys matched the helper pair; stderr had login URL; RT absent from stdout/stderr',
  };
}
