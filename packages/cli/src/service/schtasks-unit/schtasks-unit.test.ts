import { expect, test } from 'bun:test';

import {
  parseServiceSpec,
  parseTaskXml,
  renderServiceSpec,
  renderTaskXml,
  serviceSpecPath,
  serviceStatePath,
  taskPath,
} from './schtasks-unit';

const sid = 'S-1-5-21-1-2-3-1001';
const exec = 'C:\\Users\\Zoë Chen\\AppData\\Local\\aio-proxy-desktop\\bin\\aio-proxy.exe';
const specPath = 'C:\\Users\\Zoë Chen\\AppData\\Local\\aio-proxy\\service.json';

test('task XML round-trips an exec path with spaces, non-ASCII and XML metacharacters', () => {
  const odd = 'C:\\Tools & <Co>\\aio-proxy.exe';
  for (const e of [exec, odd]) {
    expect(parseTaskXml(renderTaskXml({ sid, exec: e, specPath }))).toEqual({
      sid,
      triggerUser: sid,
      exec: e,
      specPath,
    });
  }
});

test('the task XML declares UTF-16 and the restart policy schtasks needs', () => {
  const xml = renderTaskXml({ sid, exec, specPath });
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
  expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  expect(xml).toContain('<Interval>PT1M</Interval>');
  expect(xml).toContain('<Count>3</Count>');
});

test('a task that runs anything but __service-run with a spec is not ours', () => {
  const xml = renderTaskXml({ sid, exec, specPath: 'C:\\s.json' });
  expect(parseTaskXml(xml.replace('__service-run', 'run'))).toBeUndefined();
  expect(parseTaskXml(xml.replace('conhost.exe', 'cmd.exe'))).toBeUndefined();
  expect(parseTaskXml(xml.replace(' "C:\\s.json"', ''))).toBeUndefined();
  expect(parseTaskXml(xml.replace('"C:\\s.json"', '"C:\\s.json" --extra'))).toBeUndefined();
  expect(parseTaskXml('not xml')).toBeUndefined();
});

test('service spec carries the desktop marker only for a desktop-owned unit', () => {
  const spec = renderServiceSpec({
    exec,
    configPath: 'C:\\h\\config.jsonc',
    desktopExec: exec,
    upgradeMethod: 'desktop',
  });
  expect(spec.env).toMatchObject({
    AIO_PROXY_HOME: 'C:\\h',
    AIO_PROXY_MANAGED: '1',
    AIO_PROXY_DESKTOP_EXEC: exec,
    AIO_PROXY_UPGRADE_METHOD: 'desktop',
  });
  expect(parseServiceSpec(JSON.stringify(spec))).toEqual(spec);
  expect(renderServiceSpec({ exec, configPath: 'C:\\h\\config.jsonc' }).env['AIO_PROXY_DESKTOP_EXEC']).toBeUndefined();
});

test('service spec parsing rejects malformed content', () => {
  expect(parseServiceSpec('{')).toBeUndefined();
  expect(parseServiceSpec('[]')).toBeUndefined();
  expect(parseServiceSpec('{"exec":1,"env":{}}')).toBeUndefined();
  expect(parseServiceSpec('{"exec":"a","env":{"A":1}}')).toBeUndefined();
});

test('task and file paths follow the documented layout', () => {
  expect(taskPath(sid)).toBe(`\\AIO Proxy\\aio-proxy-${sid}`);
  expect(serviceSpecPath('C:\\L')).toBe('C:\\L\\aio-proxy\\service.json');
  expect(serviceStatePath('C:\\L')).toBe('C:\\L\\aio-proxy\\service.state.json');
});
