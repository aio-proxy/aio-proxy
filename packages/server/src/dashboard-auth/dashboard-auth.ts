import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { sessionKeyPath } from '@aio-proxy/core';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

type FailureWindow = { readonly startedAt: number; failures: number };

type LoginResult =
  | { readonly status: 'authenticated'; readonly expiresAt: number; readonly token: string }
  | { readonly status: 'disabled' | 'invalid' | 'unavailable' }
  | { readonly status: 'rate-limited'; readonly retryAfterSeconds: number };

export type DashboardAuthentication = {
  readonly available: () => boolean;
  readonly enabled: () => boolean;
  readonly login: (password: string, clientId: string) => Promise<LoginResult>;
  readonly verify: (token: string | undefined) => boolean;
};

export function createDashboardAuthentication(
  passwordHash: () => string | undefined,
  now: () => number = Date.now,
  available: () => boolean = () => true,
  deviceKey: () => string = deviceSessionKey,
): DashboardAuthentication {
  const failures = new Map<string, FailureWindow>();
  let resolvedDeviceKey: string | undefined;

  // The password hash alone must never be the signing key: `service-access` publishes it to the
  // sync backend, so a read-only breach there would be enough to mint a bearer token for every
  // Dashboard API without ever cracking the password. The device key is not synced, and keeping
  // the hash in the key as well is what rotates every live session when the password changes.
  function signingKey(hash: string): string {
    resolvedDeviceKey ??= deviceKey();
    return `${resolvedDeviceKey}.${hash}`;
  }

  function enabled(): boolean {
    return passwordHash() !== undefined;
  }

  async function login(password: string, clientId: string): Promise<LoginResult> {
    if (!available()) return { status: 'unavailable' };
    const hash = passwordHash();
    if (hash === undefined) return { status: 'disabled' };

    const retryAfterSeconds = retryAfter(clientId, now());
    if (retryAfterSeconds !== undefined) return { status: 'rate-limited', retryAfterSeconds };

    if (!(await Bun.password.verify(password, hash))) {
      recordFailure(clientId, now());
      return { status: 'invalid' };
    }

    failures.delete(clientId);
    const expiresAt = now() + SESSION_TTL_MS;
    const payload = `v1.${expiresAt}.${crypto.randomUUID()}`;
    return { status: 'authenticated', expiresAt, token: `${payload}.${sign(signingKey(hash), payload)}` };
  }

  function verify(token: string | undefined): boolean {
    const hash = passwordHash();
    if (hash === undefined || token === undefined) return false;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const expiresAt = Number(parts[1]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return false;
    const signature = parts[3];
    if (signature === undefined) return false;
    const payload = parts.slice(0, 3).join('.');
    return signaturesEqual(signature, sign(signingKey(hash), payload));
  }

  function retryAfter(clientId: string, timestamp: number): number | undefined {
    const window = failures.get(clientId);
    if (window === undefined) return undefined;
    const remaining = window.startedAt + FAILURE_WINDOW_MS - timestamp;
    if (remaining <= 0) {
      failures.delete(clientId);
      return undefined;
    }
    return window.failures >= MAX_FAILURES ? Math.ceil(remaining / 1_000) : undefined;
  }

  function recordFailure(clientId: string, timestamp: number): void {
    const window = failures.get(clientId);
    if (window === undefined || window.startedAt + FAILURE_WINDOW_MS <= timestamp) {
      failures.set(clientId, { failures: 1, startedAt: timestamp });
      return;
    }
    window.failures += 1;
  }

  return { available, enabled, login, verify };
}

/**
 * Clear a stale empty key file, which `wx` can never replace, so provisioning interrupted between
 * create and write does not make every login throw until someone deletes it by hand. `rmSync` on a
 * path merely observed to be empty would delete a real key another process created in the gap, so
 * the file is moved aside first: rename is atomic, and whatever lands at the scratch path is ours
 * alone to inspect. Returns the winner's key when the file turned out to have been repaired
 * already, and that key is put back before it is handed out.
 */
function clearEmptyKeyFile(path: string): string {
  const scratch = `${path}.${randomBytes(8).toString('hex')}`;
  try {
    renameSync(path, scratch);
  } catch {
    return '';
  }
  let moved = '';
  try {
    moved = readFileSync(scratch, 'utf8').trim();
  } catch {
    // Unreadable is as good as empty: nothing here can be handed out as a key.
  }
  if (moved === '') {
    rmSync(scratch, { force: true });
    return '';
  }
  try {
    writeFileSync(path, `${moved}\n`, { flag: 'wx', mode: 0o600 });
    rmSync(scratch, { force: true });
  } catch {
    // A third process already published a key. Its file is the one to keep, so drop the copy
    // rather than clobbering it, and let the next pass read whatever is now on disk.
    rmSync(scratch, { force: true });
    return '';
  }
  return moved;
}

/**
 * Read the device-local signing key, creating it on first use. `wx` plus the retry is what keeps a
 * CLI and a server racing on first start from each minting a key and invalidating the other's
 * sessions — the loser of the race reads the winner's file on the second pass.
 */
function deviceSessionKey(): string {
  const path = sessionKeyPath();
  const stored = (): string => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');
  // Three passes, because clearing a stale empty file costs one: read, clear, create, and the
  // racer that loses the re-created file still needs a pass to read the winner's key.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = stored();
    if (existing !== '') return existing;
    mkdirSync(dirname(path), { recursive: true });
    const generated = randomBytes(32).toString('base64url');
    try {
      writeFileSync(path, `${generated}\n`, { flag: 'wx', mode: 0o600 });
      return generated;
    } catch {
      // Either another process won the race — the next pass reads its key — or provisioning was
      // interrupted and left an empty file, which `wx` can never replace.
      if (stored() === '') {
        const repaired = clearEmptyKeyFile(path);
        if (repaired !== '') return repaired;
      }
    }
  }
  throw new Error('unable to establish a device session key');
}

function sign(key: string, payload: string): string {
  return new Bun.CryptoHasher('sha256', key)
    .update(payload)
    .digest('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'base64url');
  const rightBytes = Buffer.from(right, 'base64url');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
