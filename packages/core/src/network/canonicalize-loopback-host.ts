import { isIP } from 'node:net';

export function canonicalizeLoopbackHost(host: string): string | undefined {
  if (host === '::1' || host === '[::1]') return '::1';
  if (host === 'localhost') return host;
  if (isIP(host) === 4 && host.split('.')[0] === '127') return host;
}
