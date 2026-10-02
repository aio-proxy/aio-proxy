import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, win32 } from 'node:path';

export const DESKTOP_TOKEN_FILE = 'desktop-token';

/** Why a present token file was refused. Closed so it can be logged without a path or errno text. */
export type DesktopTokenRejection = 'not_regular_file' | 'foreign_owner' | 'insecure_mode' | 'unreadable' | 'malformed';

export class DesktopTokenRejectedError extends Error {
  readonly reason: DesktopTokenRejection;

  constructor(reason: DesktopTokenRejection) {
    super(`desktop token file rejected: ${reason}`);
    this.name = 'DesktopTokenRejectedError';
    this.reason = reason;
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type TokenOptions = {
  readonly uid?: number;
  /** Defaults to `process.platform`; injectable so the win32 branch runs in tests on any host. */
  readonly platform?: NodeJS.Platform;
  /** Windows only: defaults to `process.env.LOCALAPPDATA`. */
  readonly localAppData?: string;
};
type Inspection =
  | { readonly token: string }
  | { readonly missing: true }
  | { readonly rejected: DesktopTokenRejection };

const isWindows = (options: TokenOptions) => (options.platform ?? process.platform) === 'win32';

/**
 * Where the token for `home` lives. POSIX keeps it inside `home`. Windows keeps one file per resolved home
 * under the user's LocalAppData, because a Windows home directory carries no private mode bits.
 */
export function desktopTokenPath(home: string, options: TokenOptions = {}): string {
  if (!isWindows(options)) return join(home, DESKTOP_TOKEN_FILE);
  const localAppData = options.localAppData ?? process.env['LOCALAPPDATA'];
  if (!localAppData) throw new DesktopTokenRejectedError('unreadable');
  const resolved = win32
    .resolve(home)
    .replace(/[\\/]+$/u, '')
    .toLowerCase();
  const digest = createHash('sha256').update(resolved).digest('hex');
  return join(localAppData, 'aio-proxy', 'desktop-tokens', digest);
}

function inspect(path: string, options: TokenOptions): Inspection {
  const windows = isWindows(options);
  if (windows) {
    // O_NOFOLLOW does not exist on Windows; refuse a symlink or junction up front instead.
    try {
      if (lstatSync(path).isSymbolicLink()) return { rejected: 'not_regular_file' };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : { rejected: 'unreadable' };
    }
  }
  let fd: number;
  try {
    // O_NOFOLLOW refuses a symlink (ELOOP); O_NONBLOCK keeps a planted FIFO from blocking the open.
    // Every check below runs on the opened descriptor, so nothing can be swapped in between.
    fd = openSync(
      path,
      windows ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { missing: true };
    return { rejected: code === 'ELOOP' ? 'not_regular_file' : 'unreadable' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { rejected: 'not_regular_file' };
    // Windows has no POSIX uid or mode bits; the LocalAppData profile ACL is the access control.
    if (!windows) {
      const uid = options.uid ?? process.getuid?.();
      if (uid !== undefined && stat.uid !== uid) return { rejected: 'foreign_owner' };
      if ((stat.mode & 0o077) !== 0) return { rejected: 'insecure_mode' };
    }
    const token = readFileSync(fd, 'utf8').trim();
    return TOKEN_PATTERN.test(token) ? { token } : { rejected: 'malformed' };
  } catch {
    return { rejected: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}

/** The desktop token, or `undefined` when the file is missing, unreadable, or fails the ownership and permission checks. */
export function readDesktopToken(home: string, options: TokenOptions = {}): string | undefined {
  try {
    const result = inspect(desktopTokenPath(home, options), options);
    return 'token' in result ? result.token : undefined;
  } catch (error) {
    if (error instanceof DesktopTokenRejectedError) return undefined;
    throw error;
  }
}

/**
 * Returns the desktop token, creating it when absent. A present file that fails the checks is never
 * overwritten or repaired: that would silently hand a token to whoever planted the file.
 */
export function ensureDesktopToken(home: string, options: TokenOptions = {}): string {
  const path = desktopTokenPath(home, options);
  const existing = inspect(path, options);
  if ('token' in existing) return existing.token;
  if ('rejected' in existing) throw new DesktopTokenRejectedError(existing.rejected);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, randomBytes(32).toString('base64url'));
  } finally {
    closeSync(fd);
  }
  try {
    // link() never replaces an existing name, so a concurrent creator that got there first keeps its token.
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    unlinkSync(temp);
  }
  const created = inspect(path, options);
  if ('token' in created) return created.token;
  if ('rejected' in created) throw new DesktopTokenRejectedError(created.rejected);
  throw new Error('desktop token file missing after create');
}
