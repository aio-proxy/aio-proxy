import { describe, expect, test } from 'bun:test';

import { m } from '@aio-proxy/i18n';

import { plainStyle } from '../style';
import {
  formatDoctorLines,
  formatInstalledLines,
  formatPluginTable,
  formatRunSummary,
  formatStatusLine,
} from './summary';

describe('formatPluginTable', () => {
  const base = {
    label: 'Name',
    packageName: 'pkg',
    status: 'configured',
    state: 'configured',
    description: 'desc',
  } as const;
  const rowFor = (lines: readonly string[], pkg: string): number =>
    lines.findIndex((line) => line.includes(` ${pkg} `) || line.endsWith(` ${pkg}`));

  test('marks plugins by status and puts the description underneath', () => {
    const lines = formatPluginTable(plainStyle, [
      base,
      { ...base, packageName: 'built', status: 'builtin', state: 'built-in' },
      { ...base, packageName: 'missing', status: 'not_installed', state: 'not-installed' },
      { ...base, packageName: 'broken', status: 'failed', state: 'load failed: x' },
    ]);
    expect(lines[0]).toContain(m['cli.ui.header_package']().toLocaleUpperCase());
    expect(lines[rowFor(lines, 'pkg')]!.startsWith('● ')).toBe(true);
    expect(lines[rowFor(lines, 'built')]!.startsWith('● ')).toBe(true);
    expect(lines[rowFor(lines, 'missing')]!.startsWith('○ ')).toBe(true);
    const broken = rowFor(lines, 'broken');
    expect(lines[broken]!.startsWith('✗ ')).toBe(true);
    expect(lines[broken]).toContain(m['cli.plugin.state_failed']());
    expect(lines[broken + 1]).toBe('    load failed: x');
    expect(lines[rowFor(lines, 'pkg') + 1]).toBe('    desc');
  });

  test('keeps a CJK description whole on its own line', () => {
    const description = '字'.repeat(50);
    expect(formatPluginTable(plainStyle, [{ ...base, description }])).toContain(`    ${description}`);
  });

  test('shows a dash when a plugin has no display name', () => {
    const { label: _label, ...unnamed } = base;
    expect(formatPluginTable(plainStyle, [unnamed])[1]!.startsWith('● -  ')).toBe(true);
  });
});

describe('formatInstalledLines', () => {
  test('prints an aligned table with a header', () => {
    const lines = formatInstalledLines(plainStyle, [
      { packageName: 'pkg', version: '1.0.0', directory: '/tmp/pkg' },
      { packageName: '@scope/longer', version: '10.0.0', directory: '/tmp/l' },
    ]);
    expect(lines[0]).toContain(m['cli.ui.header_package']().toLocaleUpperCase());
    expect(Bun.stringWidth(lines[1]!.slice(0, lines[1]!.indexOf('1.0.0')))).toBe(
      Bun.stringWidth(lines[2]!.slice(0, lines[2]!.indexOf('10.0.0'))),
    );
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
  const valueColumn = (line: string, value: string): number => Bun.stringWidth(line.slice(0, line.indexOf(value)));

  test('prints one marked, aligned line per check', () => {
    const lines = formatDoctorLines(plainStyle, doctor);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith('● '))).toBe(true);
    expect(lines[1]).toContain('http://127.0.0.1:9317 · v1.2.3');
    expect(valueColumn(lines[0]!, '/cfg')).toBe(valueColumn(lines[1]!, 'http'));
  });

  test('marks an unreachable server as failed and no plugins as a warning', () => {
    const lines = formatDoctorLines(plainStyle, { ...doctor, reachable: false, pluginCount: 0 });
    expect(lines[1]!.startsWith('✗ ')).toBe(true);
    expect(lines[1]).toContain(m['cli.doctor.server_not_reachable']());
    expect(lines[2]!.startsWith('▲ ')).toBe(true);
    expect(lines[2]).toContain(m['cli.doctor.plugins_none']());
  });
});

describe('formatStatusLine', () => {
  test('marks a running proxy and shows address and version', () => {
    const line = formatStatusLine(plainStyle, { running: true, url: 'http://127.0.0.1:9317', version: '1.2.3' });
    expect(line).toBe(`● ${m['cli.status.state_running']()}  http://127.0.0.1:9317 · v1.2.3`);
  });

  test('omits the version instead of printing vunknown', () => {
    const line = formatStatusLine(plainStyle, { running: true, url: 'http://127.0.0.1:9317' });
    expect(line).not.toContain('unknown');
    expect(line.endsWith('http://127.0.0.1:9317')).toBe(true);
  });

  test('marks a stopped proxy with an open circle', () => {
    const line = formatStatusLine(plainStyle, { running: false, url: 'http://127.0.0.1:9317' });
    expect(line).toBe(`○ ${m['cli.status.state_not_running']()}  http://127.0.0.1:9317`);
  });
});

describe('formatRunSummary', () => {
  test('prints a block with aligned API and Dashboard addresses and no color', () => {
    const lines = formatRunSummary(plainStyle, 'http://127.0.0.1:9317', 'http://127.0.0.1:9317/dashboard');
    expect(lines[0]).toBe(`● ${m['cli.run.running']()}`);
    expect(lines[1]).toContain('http://127.0.0.1:9317');
    expect(lines[2]).toContain('http://127.0.0.1:9317/dashboard');
    expect(lines.join('\n')).not.toContain('\u001b');
  });
});
