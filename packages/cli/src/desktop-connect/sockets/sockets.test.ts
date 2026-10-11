import { expect, test } from 'bun:test';

import { runCapture } from '../../service/run-capture';
import { currentUserSid } from '../../win32-ffi';
import { servesConnection } from '../verified-get';
import { parseNetstat } from './netstat';
import { parseProcNetTcp } from './proc-net';
import { currentOwner, listSockets, type Run, type Socket } from './sockets';

const V4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1029 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1
   1: 0100007F:1029 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 2 1`;
const V6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid
   0: 00000000000000000000000001000000:1029 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000
   1: 00000000000000000000000001000000:1029 00000000000000000000000001000000:C351 01 00000000:00000000 00:00000000 00000000  1000`;

test('proc/net/tcp rows decode little-endian addresses into lsof spellings', () => {
  expect(parseProcNetTcp(V4, 'IPv4')).toEqual([
    { owner: '1000', family: 'IPv4', address: '127.0.0.1:4137' },
    { owner: '1000', family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000' },
  ]);
  expect(parseProcNetTcp(V6, 'IPv6')).toEqual([
    { owner: '1000', family: 'IPv6', address: '[::1]:4137' },
    { owner: '1000', family: 'IPv6', address: '[::1]:4137->[::1]:50001' },
  ]);
});

test('wildcard listeners are *:port and malformed rows are dropped', () => {
  const text = `header
   0: 00000000:1029 00000000:0000 0A 0:0 00:0 0  1000 0 1 1
   1: 0100007F:1029 garbage 01 0:0 00:0 0  1000
   2: 0100007F:1029 0100007F:C350 01 0:0 00:0 0  nobody`;
  expect(parseProcNetTcp(text, 'IPv4')).toEqual([{ owner: '1000', family: 'IPv4', address: '*:4137' }]);
  expect(
    parseProcNetTcp(
      '   0: 00000000000000000000000000000000:1029 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000',
      'IPv6',
    ),
  ).toEqual([{ owner: '1000', family: 'IPv6', address: '*:4137' }]);
});

test('another account serving the connection is not ours', () => {
  const sockets: readonly Socket[] = [{ owner: '1001', family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000' }];
  expect(servesConnection(sockets, '1000', '127.0.0.1:4137', '127.0.0.1:50000')).toBe(false);
  expect(servesConnection(sockets, '1001', '127.0.0.1:4137', '127.0.0.1:50000')).toBe(true);
});

const files = (map: Record<string, string>) => ({
  run: async () => ({ code: 0, stdout: '' }),
  readFile: async (path: string) => {
    const text = map[path];
    if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return text;
  },
});

test('linux listing keeps rows at the port on either end, across both families', async () => {
  const sockets = await listSockets('linux', 50000, files({ '/proc/net/tcp': V4, '/proc/net/tcp6': V6 }));
  expect(sockets).toEqual([{ owner: '1000', family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000' }]);
});

test('a missing tcp6 is tolerated, any other unreadable file fails closed', async () => {
  expect(await listSockets('linux', 4137, files({ '/proc/net/tcp': V4 }))).toHaveLength(2);
  await expect(listSockets('linux', 4137, files({ '/proc/net/tcp6': V6 }))).rejects.toThrow();
  await expect(listSockets('freebsd', 4137, files({}))).rejects.toThrow();
});

test('netstat rows map to lsof spellings for both families', () => {
  const out = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:4137         0.0.0.0:0              LISTENING       812
  TCP    127.0.0.1:4137         127.0.0.1:50000        ESTABLISHED     812
  TCP    127.0.0.1:4137         127.0.0.1:50002        TIME_WAIT       0
  TCP    127.0.0.1:4137         127.0.0.1:50003        CLOSE_WAIT      812
  TCP    [::]:4137              [::]:0                 LISTENING       812
  TCP    [::1]:4137             [::1]:50001            ESTABLISHED     812
  TCP    [0:0:0:0:0:0:0:1]:4137 [fe80::1%12]:50004     ESTABLISHED     812`;
  expect(parseNetstat(out)).toEqual([
    { family: 'IPv4', address: '127.0.0.1:4137', pid: 812 },
    { family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000', pid: 812 },
    { family: 'IPv6', address: '*:4137', pid: 812 },
    { family: 'IPv6', address: '[::1]:4137->[::1]:50001', pid: 812 },
  ]);
});

test('a localized State column maps to the same sockets as the English one', () => {
  const german = `
  Proto  Lokale Adresse         Remoteadresse          Status          PID
  TCP    127.0.0.1:4137         0.0.0.0:0              ABHÖREN         812
  TCP    127.0.0.1:4137         127.0.0.1:50000        HERGESTELLT     812
  TCP    [::]:4137              [::]:0                 ABHÖREN         812
  TCP    [::1]:4137             [::1]:50001            HERGESTELLT     812`;
  expect(parseNetstat(german)).toEqual([
    { family: 'IPv4', address: '127.0.0.1:4137', pid: 812 },
    { family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000', pid: 812 },
    { family: 'IPv6', address: '*:4137', pid: 812 },
    { family: 'IPv6', address: '[::1]:4137->[::1]:50001', pid: 812 },
  ]);
});

const NETSTAT_V4 = `  TCP    127.0.0.1:4137   0.0.0.0:0   LISTENING   812
  TCP    127.0.0.1:4137   127.0.0.1:50000   ESTABLISHED   812
  TCP    127.0.0.1:50000   127.0.0.1:4137   ESTABLISHED   900
  TCP    0.0.0.0:135   0.0.0.0:0   LISTENING   4`;
const NETSTAT_V6 = '  TCP    [::1]:4137   [::1]:50001   ESTABLISHED   813';

const ZOE = 'S-1-5-21-1-2-3-1001';
const OTHER = 'S-1-5-21-1-2-3-1002';
// 813 stands for a process whose token cannot be opened.
const sids: Record<number, string> = { 812: ZOE, 900: OTHER };
const userSid = (pid: number): string | undefined => sids[pid];

const windows = (overrides: Record<string, { code: number; stdout: string }> = {}): Run => {
  return async (cmd) => {
    const key = cmd.join(' ');
    if (key in overrides) return overrides[key] as { code: number; stdout: string };
    if (cmd[0] === 'netstat') return { code: 0, stdout: cmd[3] === 'TCPv6' ? NETSTAT_V6 : NETSTAT_V4 };
    throw new Error(`unexpected command ${key}`);
  };
};

test('windows listing owns sockets by the SID of their process; an unreadable SID yields nothing', async () => {
  const sockets = await listSockets('win32', 4137, { run: windows(), readFile: async () => '', userSid });
  expect(sockets).toEqual([
    { owner: ZOE, family: 'IPv4', address: '127.0.0.1:4137' },
    { owner: ZOE, family: 'IPv4', address: '127.0.0.1:4137->127.0.0.1:50000' },
    { owner: OTHER, family: 'IPv4', address: '127.0.0.1:50000->127.0.0.1:4137' },
  ]);
  // Another account's socket never carries our SID, whatever its account name looks like.
  expect(servesConnection(sockets, ZOE, '127.0.0.1:50000', '127.0.0.1:4137')).toBe(false);
});

test('windows listing fails closed when either netstat fails', async () => {
  for (const proto of ['TCP', 'TCPv6']) {
    const run = windows({ [`netstat -ano -p ${proto}`]: { code: 1, stdout: '' } });
    await expect(listSockets('win32', 4137, { run, readFile: async () => '', userSid })).rejects.toThrow();
  }
});

test('windows owner is this process SID, and an unreadable one throws', () => {
  expect(currentOwner('win32', () => ZOE)).toBe(ZOE);
  expect(() => currentOwner('win32', () => undefined)).toThrow();
});

test.skipIf(process.platform !== 'win32')('our own listening socket is owned by our SID', async () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  try {
    const sockets = await listSockets('win32', server.port, {
      run: runCapture,
      readFile: async () => '',
    });
    const own = currentUserSid();
    expect(own).toMatch(/^S-1-/u);
    expect(sockets).toContainEqual({ owner: own ?? '', family: 'IPv4', address: `127.0.0.1:${server.port}` });
  } finally {
    server.stop(true);
  }
});
