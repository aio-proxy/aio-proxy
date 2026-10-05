import type { Socket } from './sockets';

const LISTEN = '0A';

/** `/proc/net/tcp` writes each 32-bit word of an address in host (little-endian) byte order. */
function addressBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    for (let j = i + 6; j >= i; j -= 2) bytes.push(Number.parseInt(hex.slice(j, j + 2), 16));
  }
  return bytes;
}

/** RFC 5952 text, which is how lsof spells IPv6: lowercase, longest zero run (two or more groups) as `::`. */
export function ipv6Text(bytes: readonly number[]): string {
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[2 * i] ?? 0) << 8) | (bytes[2 * i + 1] ?? 0));
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; start++) {
    let end = start;
    while (end < 8 && groups[end] === 0) end++;
    if (end - start > bestLength) [bestStart, bestLength] = [start, end - start];
  }
  const text = (from: number, to: number) =>
    groups
      .slice(from, to)
      .map((g) => g.toString(16))
      .join(':');
  return bestStart < 0 ? text(0, 8) : `${text(0, bestStart)}::${text(bestStart + bestLength, 8)}`;
}

/** Whether `port` is at either end of an lsof-spelled address (`host:port` or `local->remote`). */
export const touchesPort = (address: string, port: number): boolean =>
  address.split('->').some((end) => end.endsWith(`:${port}`));

const isWildcard = (bytes: readonly number[]) => bytes.every((b) => b === 0);

function endpoint(hex: string, port: string, family: Socket['family']): { host: string; wildcard: boolean } {
  const bytes = addressBytes(hex);
  const host = family === 'IPv6' ? `[${ipv6Text(bytes)}]` : bytes.join('.');
  return { host: `${host}:${Number.parseInt(port, 16)}`, wildcard: isWildcard(bytes) };
}

const ROW = /^\d+:$/u;

/**
 * The sockets in `/proc/net/tcp` (or `tcp6`), in lsof's spelling: a LISTEN row is `host:port` (`*:port`
 * on the wildcard), any other row `local->remote`. Rows that do not parse are dropped, never guessed.
 */
export function parseProcNetTcp(text: string, family: Socket['family']): Socket[] {
  const hexLength = family === 'IPv6' ? 32 : 8;
  const addressPattern = new RegExp(`^([0-9A-F]{${hexLength}}):([0-9A-F]{4})$`, 'iu');
  const sockets: Socket[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/u);
    const [index = '', local = '', remote = '', state = '', , , , owner = ''] = fields;
    const localMatch = addressPattern.exec(local);
    const remoteMatch = addressPattern.exec(remote);
    if (!ROW.test(index) || localMatch === null || remoteMatch === null || !/^\d+$/u.test(owner)) continue;
    const from = endpoint(localMatch[1] ?? '', localMatch[2] ?? '', family);
    if (state.toUpperCase() === LISTEN) {
      const port = from.host.slice(from.host.lastIndexOf(':') + 1);
      sockets.push({ owner, family, address: from.wildcard ? `*:${port}` : from.host });
      continue;
    }
    const to = endpoint(remoteMatch[1] ?? '', remoteMatch[2] ?? '', family);
    sockets.push({ owner, family, address: `${from.host}->${to.host}` });
  }
  return sockets;
}
