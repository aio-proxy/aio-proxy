import { expect, test } from 'bun:test';

import { servesConnection } from '../verified-get';
import { parseProcNetTcp } from './proc-net';
import { listSockets, type Socket } from './sockets';

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
  await expect(listSockets('win32', 4137, files({}))).rejects.toThrow();
});
