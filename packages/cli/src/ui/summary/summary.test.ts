import { describe, expect, test } from 'bun:test';

import { m } from '@aio-proxy/i18n';

import { plainStyle } from '../style';
import {
  formatDoctorLines,
  formatInstalledLines,
  formatPluginLines,
  formatRunSummary,
  formatStatusLine,
} from './summary';

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
