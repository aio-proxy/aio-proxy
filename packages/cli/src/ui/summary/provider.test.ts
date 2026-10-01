import { describe, expect, test } from 'bun:test';

import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';

import { plainStyle } from '../style';
import { formatDeepProviderLines, formatProviderLines } from './provider';

const provider: DashboardProviderSummary = {
  id: 'openai',
  kind: 'api',
  enabled: true,
  passthrough: false,
  last_status: 'ok',
  last_latency: 212,
  protocols: [],
  hasQuota: false,
  canRefreshCredential: false,
  clientModels: [],
  state: { status: 'ready', catalog: 'fresh' },
};
const diagnostic = {
  code: 'CATALOG_UNAVAILABLE',
  summary: 'catalog fetch failed',
  retryable: true,
  occurredAt: '2026-10-01T00:00:00.000Z',
  suggestedCommand: 'aio-proxy provider test copilot',
} as const;

const rowFor = (lines: readonly string[], id: string): string => lines.find((line) => line.includes(` ${id} `))!;

describe('formatProviderLines table', () => {
  test('marks each provider by state', () => {
    const lines = formatProviderLines(
      plainStyle,
      [
        provider,
        { ...provider, id: 'off', enabled: false },
        { ...provider, id: 'down', state: { status: 'unavailable', diagnostic } },
        { ...provider, id: 'stale', state: { status: 'ready', catalog: 'stale' } },
      ],
      false,
    );
    expect(rowFor(lines, 'openai').startsWith('● ')).toBe(true);
    expect(rowFor(lines, 'off').startsWith('○ ')).toBe(true);
    expect(rowFor(lines, 'down').startsWith('✗ ')).toBe(true);
    expect(rowFor(lines, 'stale').startsWith('▲ ')).toBe(true);
  });

  test('prints a header and latency in milliseconds', () => {
    const lines = formatProviderLines(plainStyle, [provider, { ...provider, id: 'b', last_latency: null }], false);
    expect(lines[0]).toContain(m['cli.provider.list.header_id']().toLocaleUpperCase());
    expect(rowFor(lines, 'openai')).toContain('212ms');
    expect(lines.join('\n')).not.toContain('passthrough');
  });

  test('puts the diagnostic and suggested command under the row', () => {
    const lines = formatProviderLines(
      plainStyle,
      [provider, { ...provider, id: 'copilot', state: { status: 'ready', catalog: 'fresh', diagnostic } }],
      false,
    );
    const row = lines.indexOf(rowFor(lines, 'copilot'));
    expect(lines[row + 1]).toBe('    catalog fetch failed');
    expect(lines[row + 2]).toBe('    → aio-proxy provider test copilot');
  });

  test('adds a probe column with --probe', () => {
    const lines = formatProviderLines(plainStyle, [provider, { ...provider, id: 'b', probe: 'OK' }], true);
    expect(lines[0]).toContain(m['cli.provider.list.header_probe']().toLocaleUpperCase());
    expect(rowFor(lines, 'openai')).toContain('FAIL');
    expect(rowFor(lines, 'b')).toContain('OK');
  });

  test('keeps a 200-character provider id intact', () => {
    const id = 'x'.repeat(200);
    const text = formatProviderLines(plainStyle, [provider, { ...provider, id }], false).join('\n');
    expect(text).toContain(id);
  });
});

describe('formatProviderLines detail', () => {
  test('shows every field for exactly one provider', () => {
    const lines = formatProviderLines(plainStyle, [provider], true);
    expect(lines[0]).toBe('● openai');
    expect(lines).toHaveLength(1 + 16);
    for (const key of ['header_passthrough', 'header_account', 'header_suggested_command', 'header_probe'] as const) {
      expect(lines.join('\n')).toContain(m[`cli.provider.list.${key}`]());
    }
  });

  test('keeps a 200-character provider id intact', () => {
    const id = 'x'.repeat(200);
    expect(formatProviderLines(plainStyle, [{ ...provider, id }], false)[0]).toBe(`● ${id}`);
  });
});

test('returns the empty copy when there are no providers', () => {
  expect(formatProviderLines(plainStyle, [], false)).toEqual([m['cli.ui.provider_list_empty']()]);
});

test('formatDeepProviderLines formats a probe view and rejects unexpected payloads', () => {
  expect(formatDeepProviderLines(plainStyle, { providers: [provider] })?.join('\n')).toContain('FAIL');
  expect(formatDeepProviderLines(plainStyle, { providers: 'nope' })).toBeUndefined();
});
