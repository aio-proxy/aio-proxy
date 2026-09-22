import { describe, expect, test } from 'bun:test';

import { m } from '@aio-proxy/i18n';

import {
  formatDeepProviderLines,
  formatDoctorLines,
  formatInstalledLines,
  formatPluginLines,
  formatProviderLines,
  formatRunSummary,
  formatStatusLine,
} from './summary';

const provider = {
  id: 'openai',
  kind: 'api',
  enabled: true,
  passthrough: false,
  last_status: 'ok',
  last_latency: 0,
  protocols: [],
  hasQuota: false,
  canRefreshCredential: false,
  clientModels: [],
  state: { status: 'ready', catalog: 'fresh' },
} as const;

describe('formatProviderLines', () => {
  test('prints one labeled field per line without pipes or color', () => {
    const text = formatProviderLines([provider], false, false).join('\n');
    expect(text).toContain('id: openai');
    expect(text).toContain('last_latency: 0');
    expect(text).toContain('catalog: fresh');
    expect(text).not.toContain('|');
    expect(text).not.toContain('\u001b');
  });

  test('dims labels when color is requested', () => {
    const text = formatProviderLines([provider], false, true).join('\n');
    expect(text).toContain('\u001b[2mid\u001b[0m: openai');
  });

  test('separates providers with one blank line and does not trail one', () => {
    const lines = formatProviderLines([provider, { ...provider, id: 'anthropic' }], false, false);
    const secondId = lines.findIndex((line) => line.startsWith('id: anthropic'));
    expect(lines[secondId - 1]).toBe('');
    expect(lines.at(-1)).not.toBe('');
  });

  test('returns the empty copy when there are no providers', () => {
    expect(formatProviderLines([], false, false)).toEqual([m['cli.ui.provider_list_empty']()]);
  });

  test('keeps a 200-character provider id intact', () => {
    const id = 'x'.repeat(200);
    const text = formatProviderLines([{ ...provider, id }], false, false).join('\n');
    expect(text).toContain(id);
  });
});

describe('formatDeepProviderLines', () => {
  test('formats a probe view when the payload parses and returns undefined otherwise', () => {
    const text = formatDeepProviderLines({ providers: [provider] }, false)?.join('\n');
    expect(text).toContain('id: openai');
    expect(text).toContain('probe: FAIL');
    expect(formatDeepProviderLines({ providers: 'nope' }, false)).toBeUndefined();
  });
});

describe('formatPluginLines', () => {
  const plugin = { label: 'Name', packageName: 'pkg', state: 'configured', description: 'desc' };

  test('keeps the legacy sentence when the line fits', () => {
    expect(formatPluginLines(plugin, 120)).toEqual(['Name (pkg) configured — desc']);
  });

  test('splits present fields when the width is unknown', () => {
    expect(formatPluginLines(plugin, undefined)).toEqual(['Name', 'pkg', 'configured', 'desc']);
  });

  test('does not slice a description wider than the terminal', () => {
    const description = '字'.repeat(50);
    const lines = formatPluginLines({ ...plugin, description }, 80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('\n')).toContain(description);
  });
});

describe('formatInstalledLines', () => {
  const item = { packageName: 'pkg', version: '1.0.0', directory: '/tmp/pkg' };

  test('keeps the legacy sentence when the line fits', () => {
    expect(formatInstalledLines(item, 120)).toEqual(['pkg 1.0.0 /tmp/pkg']);
  });

  test('splits the three fields when the terminal is narrow', () => {
    expect(formatInstalledLines(item, 20)).toEqual(['pkg', '1.0.0', '/tmp/pkg']);
  });
});

describe('formatDoctorLines', () => {
  const doctor = {
    configPath: '/cfg',
    url: 'http://127.0.0.1:9317',
    version: '1.2.3',
    reachable: true,
    pluginCount: 2,
  };

  test('joins the three sentences when the line fits', () => {
    const lines = formatDoctorLines(doctor, 200);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('● ');
    expect(lines[0]).toContain('1.2.3');
  });

  test('marks only the server sentence when the width is unknown', () => {
    const lines = formatDoctorLines(doctor, undefined);
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith('● '))).toEqual([lines[1]]);
  });

  test('marks an unreachable server with an open circle', () => {
    const lines = formatDoctorLines({ ...doctor, reachable: false }, undefined);
    expect(lines[1]?.startsWith('○ ')).toBe(true);
  });
});

describe('formatStatusLine', () => {
  test('marks a running proxy and keeps the address and version', () => {
    const line = formatStatusLine({ running: true, url: 'http://127.0.0.1:9317', version: '1.2.3' });
    expect(line.startsWith('● ')).toBe(true);
    expect(line).toContain('1.2.3');
    expect(line).toContain('9317');
  });

  test('marks a stopped proxy with an open circle', () => {
    const line = formatStatusLine({ running: false, url: 'http://127.0.0.1:9317' });
    expect(line.startsWith('○ ')).toBe(true);
  });
});

describe('formatRunSummary', () => {
  test('marks startup and includes both URLs without color', () => {
    const line = formatRunSummary('http://127.0.0.1:9317', 'http://127.0.0.1:9317/dashboard');
    expect(line.startsWith('● ')).toBe(true);
    expect(line).toContain('http://127.0.0.1:9317');
    expect(line).toContain('http://127.0.0.1:9317/dashboard');
    expect(line).not.toContain('\u001b');
  });
});
