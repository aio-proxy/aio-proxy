import { expect, test } from 'bun:test';

import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import { readXAIGrokQuota, resetXAIGrokQuota } from './quota';
import type { XAIGrokCredential } from './schema';

const SOON = Date.parse('2027-10-01T00:00:00Z');
const LATER = Date.parse('2027-12-01T00:00:00Z');

test('lists unexpired reset tokens and redeems the soonest one', async () => {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.endsWith('/GetRemainingResets')) return new Response(resetList(SOON / 1000, LATER / 1000));
    if (request.url.endsWith('/RedeemReset')) return new Response(grpcStatus(0));
    if (request.url.endsWith('?format=credits')) {
      return Response.json({
        config: { currentPeriod: { end: '2027-01-15T00:00:00Z' }, creditUsagePercent: 40 },
      });
    }
    return Response.json({
      config: { monthlyLimit: { val: 100 }, used: { val: 0 }, billingPeriodEnd: '2027-02-01T00:00:00Z' },
    });
  };

  const snapshot = await readXAIGrokQuota(context(), { fetch });
  expect(snapshot.items.find((item) => item.id === 'weekly')?.remainingRatio).toBe(0.6);
  expect(snapshot.resetCredits).toEqual({
    availableCount: 2,
    items: [
      { id: 'soon', expiresAt: SOON },
      { id: 'later', expiresAt: LATER },
    ],
  });

  await resetXAIGrokQuota(context(), { fetch });
  const redeem = requests.find((request) => request.url.endsWith('/RedeemReset'));
  const redeemBody = new TextDecoder().decode(await redeem?.arrayBuffer());
  expect(redeemBody).toContain('soon');
  expect(redeemBody).not.toContain('later');
});

test('a failed reset inventory leaves the usage window in place', async () => {
  const snapshot = await readXAIGrokQuota(context(), {
    fetch: async (input) => {
      const url = input.toString();
      if (url.endsWith('/GetRemainingResets')) return new Response(null, { status: 503 });
      if (url.endsWith('?format=credits')) {
        return Response.json({ config: { currentPeriod: { end: '2027-01-15T00:00:00Z' } } });
      }
      return Response.json({ config: {} });
    },
  });
  expect(snapshot.items.find((item) => item.id === 'weekly')?.remainingRatio).toBe(1);
  expect(snapshot).not.toHaveProperty('resetCredits');
});

test('an expired reset token is not offered', async () => {
  const snapshot = await readXAIGrokQuota(context(), {
    fetch: async (input) => {
      const url = input.toString();
      if (url.endsWith('/GetRemainingResets'))
        return new Response(resetList(Date.parse('2020-01-01T00:00:00Z') / 1000));
      if (url.endsWith('?format=credits')) {
        return Response.json({ config: { currentPeriod: { end: '2027-01-15T00:00:00Z' }, creditUsagePercent: 10 } });
      }
      return Response.json({ config: {} });
    },
  });
  expect(snapshot.resetCredits).toEqual({ availableCount: 0 });
});

function context() {
  return { credentials: port(), options: {}, signal: new AbortController().signal };
}

function port(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: {
        accessToken: 'access-token',
        refreshToken: 'refresh',
        expiresAt: 1_900_000_000_000,
        subject: 'user-123',
      },
    }),
    refresh: async () => {
      throw new Error('fresh credential must not refresh');
    },
  };
}

function resetList(...expirySeconds: number[]): Uint8Array {
  const ids = ['soon', 'later'];
  const messages = expirySeconds.map((seconds, index) => tokenFrame(ids[index] ?? `token-${index}`, seconds));
  const payload = concat(messages);
  return concat([frame(0, payload), frame(0x80, new TextEncoder().encode('grpc-status: 0\r\n'))]);
}

function grpcStatus(status: number): Uint8Array {
  return frame(0x80, new TextEncoder().encode(`grpc-status: ${status}\r\n`));
}

function tokenFrame(id: string, expirySeconds: number): Uint8Array {
  const idField = delimited(10, new TextEncoder().encode(id));
  const seconds = varint(expirySeconds);
  const timestamp = new Uint8Array(1 + seconds.length);
  timestamp[0] = 8;
  timestamp.set(seconds, 1);
  const expiry = delimited(30, timestamp);
  return delimited(10, concat([idField, expiry]));
}

function delimited(field: number, data: Uint8Array): Uint8Array {
  const tag = varint((field << 3) | 2);
  const length = varint(data.length);
  const out = new Uint8Array(tag.length + length.length + data.length);
  out.set(tag, 0);
  out.set(length, tag.length);
  out.set(data, tag.length + length.length);
  return out;
}

function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

function frame(flags: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags;
  out[1] = (payload.length >>> 24) & 0xff;
  out[2] = (payload.length >>> 16) & 0xff;
  out[3] = (payload.length >>> 8) & 0xff;
  out[4] = payload.length & 0xff;
  out.set(payload, 5);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
