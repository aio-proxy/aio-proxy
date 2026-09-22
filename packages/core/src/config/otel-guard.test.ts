import { expect, test } from 'bun:test';

import { parseRuntimeConfig } from './parse-runtime-config';

const base = { providers: {} };

test('rejects a missing otel env var even when the expanded string stays non-empty', () => {
  expect(() =>
    parseRuntimeConfig(
      {
        ...base,
        server: {
          otel: {
            destinations: [
              { url: 'https://collector.example/v1/traces', headers: { Authorization: 'Bearer {{env.MISSING}}' } },
            ],
          },
        },
      },
      {},
    ),
  ).toThrow(/MISSING/u);
});

test.each([
  'https://collector.example/{{env.MISSING}}/v1/traces',
  'https://collector.example/v1/traces?token={{env.MISSING}}',
])('rejects a missing variable embedded in %s', (url) => {
  expect(() => parseRuntimeConfig({ ...base, server: { otel: { destinations: [{ url }] } } }, {})).toThrow(/MISSING/u);
});

test('still accepts a missing env var outside server.otel', () => {
  const config = parseRuntimeConfig({ ...base, server: { apiKeys: [{ key: 'prefix-{{env.MISSING}}-suffix' }] } }, {});
  expect(config.server.apiKeys[0]?.key).toBe('prefix--suffix');
});

test('rejects CR and LF in an expanded otel header before the value is stored', () => {
  expect(() =>
    parseRuntimeConfig(
      {
        ...base,
        server: {
          otel: {
            destinations: [
              { url: 'https://collector.example/v1/traces', headers: { Authorization: 'Bearer bad\rvalue' } },
            ],
          },
        },
      },
      {},
    ),
  ).toThrow(TypeError);
});

test('rejects destinations when an OTLP header environment variable is set', () => {
  expect(() =>
    parseRuntimeConfig(
      { ...base, server: { otel: { destinations: [{ url: 'https://collector.example/v1/traces' }] } } },
      { OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer other' },
    ),
  ).toThrow(/OTEL_EXPORTER_OTLP_HEADERS/u);
});

test('allows that environment variable when there are no destinations', () => {
  expect(
    parseRuntimeConfig(base, { OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer other' }).server.otel
      .destinations,
  ).toEqual([]);
});
