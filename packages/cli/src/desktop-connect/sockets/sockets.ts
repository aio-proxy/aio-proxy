import { listWindowsSockets } from './netstat';
import { parseProcNetTcp } from './proc-net';

export type Run = (cmd: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;

/** `owner` is the account that holds the socket: `String(uid)` on POSIX. */
export type Socket = { readonly owner: string; readonly family: 'IPv4' | 'IPv6'; readonly address: string };

export type ListSocketsDeps = { readonly run: Run; readonly readFile: (path: string) => Promise<string> };

/** The sockets in `lsof -F tun` output: each file's family and name, under its process's uid. */
export function parseSockets(lsofOutput: string): readonly Socket[] {
  const sockets: Socket[] = [];
  let owner = '';
  let family = '';
  for (const line of lsofOutput.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('u')) owner = /^\d+$/u.test(value) ? value : '';
    else if (line.startsWith('f')) family = '';
    else if (line.startsWith('t')) family = value;
    else if (line.startsWith('n') && owner !== '' && (family === 'IPv4' || family === 'IPv6')) {
      sockets.push({ owner, family, address: value });
    }
  }
  return sockets;
}

const touchesPort = (socket: Socket, port: number): boolean =>
  socket.address.split('->').some((end) => end.endsWith(`:${port}`));

const isMissing = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'ENOENT';

/**
 * The TCP sockets with `port` at either end. Throws when the listing cannot be read: callers treat a
 * throw as "not ours", so nothing sensitive is sent on a guess.
 */
export async function listSockets(
  platform: NodeJS.Platform,
  port: number,
  deps: ListSocketsDeps,
): Promise<readonly Socket[]> {
  if (platform === 'darwin') {
    const { stdout } = await deps.run(['/usr/sbin/lsof', '-nP', `-iTCP:${port}`, '-Ftun']);
    return parseSockets(stdout);
  }
  if (platform === 'linux') {
    const v4 = parseProcNetTcp(await deps.readFile('/proc/net/tcp'), 'IPv4');
    // A kernel without IPv6 has no tcp6 file, and nothing there to serve a connection.
    const v6 = parseProcNetTcp(await deps.readFile('/proc/net/tcp6').catch(failUnlessMissing), 'IPv6');
    return [...v4, ...v6].filter((socket) => touchesPort(socket, port));
  }
  if (platform === 'win32') return listWindowsSockets(port, deps.run);
  throw new Error(`no socket listing for ${platform}`);
}

function failUnlessMissing(error: unknown): string {
  if (isMissing(error)) return '';
  throw error;
}

/**
 * The owner string `Socket.owner` carries for this process's own account: the uid on POSIX, the
 * lower-cased `DOMAIN\user` from `whoami` on Windows (account names compare case-insensitively there).
 */
export async function currentOwner(platform: NodeJS.Platform, run?: Run): Promise<string> {
  if ((platform === 'darwin' || platform === 'linux') && process.getuid !== undefined) {
    return String(process.getuid());
  }
  if (platform === 'win32' && run !== undefined) {
    const { code, stdout } = await run(['whoami']);
    const name = stdout.trim();
    if (code === 0 && name !== '') return name.toLowerCase();
  }
  throw new Error(`no account owner for ${platform}`);
}
