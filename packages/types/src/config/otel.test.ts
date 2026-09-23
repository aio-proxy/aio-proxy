import { expect, test } from 'bun:test';

import { ConfigAuthoringSchema, ConfigSchema } from '..';

const destination = {
  url: 'https://collector.example/v1/traces',
  headers: { Authorization: 'Bearer secret' },
};

test('defaults to no otel destinations and json content type', () => {
  const config = ConfigSchema.parse({ providers: {} });
  expect(config.server.otel.destinations).toEqual([]);
  const parsed = ConfigSchema.parse({ server: { otel: { destinations: [destination] } }, providers: {} });
  expect(parsed.server.otel.destinations[0]?.contentType).toBe('json');
});

test('accepts an authoring template in the url and header', () => {
  const parsed = ConfigAuthoringSchema.safeParse({
    server: {
      otel: {
        destinations: [
          {
            url: 'https://collector.example/{{env.OTLP_PATH}}',
            headers: { Authorization: 'Bearer {{env.OTLP_TOKEN}}' },
          },
        ],
      },
    },
    providers: {},
  });
  expect(parsed.success).toBe(true);
});

test.each([
  ['ftp', 'ftp://collector.example/v1/traces'],
  ['userinfo', 'https://user:pass@collector.example/v1/traces'],
  ['fragment', 'https://collector.example/v1/traces#x'],
])('rejects an otel url with %s', (_label, url) => {
  expect(ConfigSchema.safeParse({ server: { otel: { destinations: [{ url }] } }, providers: {} }).success).toBe(false);
});

test('rejects a ninth destination, a 17th header, a forbidden header, and a duplicate header name', () => {
  const nine = Array.from({ length: 9 }, () => destination);
  expect(ConfigSchema.safeParse({ server: { otel: { destinations: nine } }, providers: {} }).success).toBe(false);
  const headers = Object.fromEntries(Array.from({ length: 17 }, (_value, index) => [`X-${index}`, 'v']));
  expect(
    ConfigSchema.safeParse({ server: { otel: { destinations: [{ ...destination, headers }] } }, providers: {} })
      .success,
  ).toBe(false);
  expect(
    ConfigSchema.safeParse({
      server: { otel: { destinations: [{ ...destination, headers: { 'Content-Type': 'text/plain' } }] } },
      providers: {},
    }).success,
  ).toBe(false);
  expect(
    ConfigSchema.safeParse({
      server: { otel: { destinations: [{ ...destination, headers: { Authorization: 'a', authorization: 'b' } }] } },
      providers: {},
    }).success,
  ).toBe(false);
});
