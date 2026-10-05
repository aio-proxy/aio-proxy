import { ipv6Text, touchesPort } from './proc-net';
import type { Run, Socket } from './sockets';

const ROW = /^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/u;
const IPV4 = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/u;
// A zone suffix (`%12`) is deliberately not matched: such a row is dropped, never guessed.
const IPV6 = /^\[([0-9a-f:.]+)\]:(\d+)$/iu;

type Endpoint = { readonly family: Socket['family']; readonly host: string; readonly wildcard: boolean; port: string };

/** The 16 bytes of an IPv6 literal (`::` compression and a dotted IPv4 tail allowed); undefined when malformed. */
function ipv6Bytes(text: string): number[] | undefined {
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    const out: number[] = [];
    for (const piece of part === '' ? [] : part.split(':')) {
      const dotted = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(piece);
      if (dotted !== null) {
        const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
        if ([a, b, c, d].some((n) => n > 255)) return undefined;
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/iu.test(piece)) out.push(Number.parseInt(piece, 16));
      else return undefined;
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  return [...head, ...Array<number>(Math.max(missing, 0)).fill(0), ...tail].flatMap((g) => [g >> 8, g & 0xff]);
}

function endpoint(text: string): Endpoint | undefined {
  const v4 = IPV4.exec(text);
  if (v4 !== null) {
    const host = v4[1] ?? '';
    if (host.split('.').some((n) => Number(n) > 255)) return undefined;
    return { family: 'IPv4', host, wildcard: host === '0.0.0.0', port: v4[2] ?? '' };
  }
  const v6 = IPV6.exec(text);
  const bytes = v6 === null ? undefined : ipv6Bytes(v6[1] ?? '');
  if (v6 === null || bytes === undefined) return undefined;
  return { family: 'IPv6', host: `[${ipv6Text(bytes)}]`, wildcard: bytes.every((b) => b === 0), port: v6[2] ?? '' };
}

/**
 * The rows of `netstat -ano -p TCP|TCPv6` in lsof's spelling: a listener row is `host:port` (`*:port`
 * on the wildcard), any other row `local->remote`. Dying connections and rows that do not parse are
 * dropped, never guessed.
 */
export function parseNetstat(text: string): { family: Socket['family']; address: string; pid: number }[] {
  const rows: { family: Socket['family']; address: string; pid: number }[] = [];
  for (const line of text.split('\n')) {
    const match = ROW.exec(line.replace(/\r$/u, ''));
    // English names only skip dying connections early; a localized one is kept, and owned by PID 0.
    if (match === null || match[3] === 'TIME_WAIT' || match[3] === 'CLOSE_WAIT') continue;
    const local = endpoint(match[1] ?? '');
    const remote = endpoint(match[2] ?? '');
    if (local === undefined || remote === undefined || local.family !== remote.family) continue;
    // The State column is localized (German `ABHÖREN`), so a listener is the row whose peer is the
    // wildcard at port 0, not the row that says LISTENING.
    const isListener = remote.wildcard && remote.port === '0';
    const address = isListener
      ? `${local.wildcard ? '*' : local.host}:${local.port}`
      : `${local.host}:${local.port}->${remote.host}:${remote.port}`;
    rows.push({ family: local.family, address, pid: Number(match[4]) });
  }
  return rows;
}

/**
 * The TCP sockets with `port` at either end, each owned by the SID of its process's account. A process
 * whose SID cannot be read owns nothing here. A failing `netstat` throws: callers treat a throw as "not
 * ours".
 */
export async function listWindowsSockets(
  port: number,
  run: Run,
  userSid: (pid: number) => string | undefined,
): Promise<readonly Socket[]> {
  const rows = [];
  for (const proto of ['TCP', 'TCPv6']) {
    const { code, stdout } = await run(['netstat', '-ano', '-p', proto]);
    if (code !== 0) throw new Error(`netstat -p ${proto} exited ${code}`);
    rows.push(...parseNetstat(stdout).filter((row) => touchesPort(row.address, port)));
  }
  const owners = new Map<number, string | undefined>();
  for (const pid of new Set(rows.map((row) => row.pid))) owners.set(pid, userSid(pid));
  return rows.flatMap(({ pid, ...row }) => {
    const owner = owners.get(pid);
    return owner === undefined ? [] : [{ owner, ...row }];
  });
}
