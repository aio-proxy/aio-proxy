import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DESKTOP_TOKEN_FILE,
  DesktopTokenRejectedError,
  type DesktopTokenRejection,
  desktopTokenPath,
  ensureDesktopToken,
  readDesktopToken,
} from './desktop-token';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aio-desktop-token-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const tokenPath = () => join(home, DESKTOP_TOKEN_FILE);
const validToken = 'A'.repeat(43);

const rejectionOf = (create: () => unknown): DesktopTokenRejection | undefined => {
  try {
    create();
  } catch (error) {
    if (error instanceof DesktopTokenRejectedError) return error.reason;
    throw error;
  }
  return undefined;
};

test.skipIf(process.platform === 'win32')('creates a private token once and returns the same value afterwards', () => {
  const first = ensureDesktopToken(home);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
  expect(ensureDesktopToken(home)).toBe(first);
  expect(readDesktopToken(home)).toBe(first);
});

test.skipIf(process.platform === 'win32')(
  'never replaces an existing valid token, including one with a trailing newline',
  () => {
    writeFileSync(tokenPath(), `${validToken}\n`, { mode: 0o600 });
    expect(ensureDesktopToken(home)).toBe(validToken);
    expect(readFileSync(tokenPath(), 'utf8')).toBe(`${validToken}\n`);
  },
);

test('a missing file reads as no token', () => {
  expect(readDesktopToken(home)).toBeUndefined();
});

for (const [name, reason, arrange] of [
  [
    'group-readable',
    'insecure_mode',
    () => {
      writeFileSync(tokenPath(), validToken, { mode: 0o600 });
      chmodSync(tokenPath(), 0o640);
    },
  ],
  [
    'a symlink',
    'not_regular_file',
    () => {
      const target = join(home, 'elsewhere');
      writeFileSync(target, validToken, { mode: 0o600 });
      symlinkSync(target, tokenPath());
    },
  ],
  ['malformed', 'malformed', () => writeFileSync(tokenPath(), 'short', { mode: 0o600 })],
] as const) {
  test.skipIf(process.platform === 'win32')(`a ${name} token file is rejected as ${reason} and left untouched`, () => {
    arrange();
    const before = readFileSync(tokenPath(), 'utf8');
    expect(readDesktopToken(home)).toBeUndefined();
    expect(rejectionOf(() => ensureDesktopToken(home))).toBe(reason);
    expect(readFileSync(tokenPath(), 'utf8')).toBe(before);
  });
}

test.skipIf(process.platform === 'win32')('a token file owned by another uid is rejected', () => {
  writeFileSync(tokenPath(), validToken, { mode: 0o600 });
  const otherUid = (process.getuid?.() ?? 0) + 1;
  expect(readDesktopToken(home, { uid: otherUid })).toBeUndefined();
  expect(rejectionOf(() => ensureDesktopToken(home, { uid: otherUid }))).toBe('foreign_owner');
});

// Root can read a 0000 file, so the case only exists for a normal user.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'an unreadable token file reads as no token instead of throwing',
  () => {
    writeFileSync(tokenPath(), validToken, { mode: 0o600 });
    chmodSync(tokenPath(), 0o000);
    expect(readDesktopToken(home)).toBeUndefined();
    expect(rejectionOf(() => ensureDesktopToken(home))).toBe('unreadable');
  },
);

// Opening a FIFO for reading blocks until a writer appears; the check must not hang the server's boot.
test.skipIf(process.platform === 'win32')('a FIFO planted as the token file is rejected without blocking', () => {
  expect(Bun.spawnSync(['mkfifo', tokenPath()]).exitCode).toBe(0);
  expect(readDesktopToken(home)).toBeUndefined();
  expect(rejectionOf(() => ensureDesktopToken(home))).toBe('not_regular_file');
});

test('concurrent creators in separate processes agree on one token', async () => {
  const modulePath = join(import.meta.dir, 'desktop-token.ts');
  for (let round = 0; round < 10; round += 1) {
    const roundHome = join(home, `round-${round}`);
    const script = `import { ensureDesktopToken } from ${JSON.stringify(modulePath)}; console.log(ensureDesktopToken(${JSON.stringify(roundHome)}));`;
    const runs = [0, 1].map(() => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
    const outputs = await Promise.all(runs.map(async (proc) => (await new Response(proc.stdout).text()).trim()));
    expect(outputs[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(outputs[1]).toBe(outputs[0]);
  }
});

test('win32 keeps one token per resolved home under LOCALAPPDATA', () => {
  const opts = { platform: 'win32' as const, localAppData: join(home, 'LocalAppData') };
  const a = desktopTokenPath('C:\\Users\\Zoë Chen\\.aio-proxy', opts);
  expect(a.startsWith(join(home, 'LocalAppData', 'aio-proxy', 'desktop-tokens'))).toBe(true);
  expect(desktopTokenPath('c:\\users\\zoë chen\\.aio-proxy\\', opts)).toBe(a);
  expect(desktopTokenPath('D:\\other-home', opts)).not.toBe(a);
});

test('win32 creates and reads the token without POSIX mode checks, and rejects a symlink', () => {
  const opts = { platform: 'win32' as const, localAppData: join(home, 'LocalAppData') };
  const token = ensureDesktopToken('C:\\h', opts);
  expect(readDesktopToken('C:\\h', opts)).toBe(token);
  const path = desktopTokenPath('C:\\h2', opts);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(join(home, 'elsewhere'), path);
  expect(readDesktopToken('C:\\h2', opts)).toBeUndefined();
  expect(rejectionOf(() => ensureDesktopToken('C:\\h2', opts))).toBe('not_regular_file');
});

test('win32 without LOCALAPPDATA refuses instead of guessing a location', () => {
  const previous = process.env.LOCALAPPDATA;
  delete process.env.LOCALAPPDATA;
  try {
    expect(readDesktopToken('C:\\h', { platform: 'win32' })).toBeUndefined();
    expect(rejectionOf(() => ensureDesktopToken('C:\\h', { platform: 'win32' }))).toBe('unreadable');
  } finally {
    if (previous !== undefined) process.env.LOCALAPPDATA = previous;
  }
});
