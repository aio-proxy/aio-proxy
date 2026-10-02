import { expect, test } from 'bun:test';

import {
  isOwnTask,
  parseServiceSpec,
  parseTaskXml,
  renderServiceSpec,
  renderTaskXml,
  serviceSpecPath,
  serviceStatePath,
  serviceStatePathBeside,
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
      enabled: true,
      action: { exec: e, specPath },
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

test('a task that runs anything but __service-run with a spec has no action of ours', () => {
  const xml = renderTaskXml({ sid, exec, specPath: 'C:\\s.json' });
  expect(parseTaskXml(xml.replace('__service-run', 'run'))?.action).toBeUndefined();
  expect(parseTaskXml(xml.replace('conhost.exe', 'cmd.exe'))?.action).toBeUndefined();
  expect(parseTaskXml(xml.replace(' "C:\\s.json"', ''))?.action).toBeUndefined();
  expect(parseTaskXml(xml.replace('"C:\\s.json"', '"C:\\s.json" --extra'))?.action).toBeUndefined();
  // Whose the task is still reads, so install can refuse another user's task at our path.
  expect(parseTaskXml(xml.replace('conhost.exe', 'cmd.exe'))?.sid).toBe(sid);
  expect(parseTaskXml('not xml')).toBeUndefined();
});

test('a task is ours when its principal and its trigger, if any, name this user by SID or account', () => {
  const user = { sid, account: 'DESKTOP-1\\Zoë Chen' };
  const xml = renderTaskXml({ sid, exec, specPath });
  const withTrigger = (name: string) => xml.replace(/(<LogonTrigger>[\s\S]*?<UserId>)[^<]*/u, `$1${name}`);
  expect(isOwnTask(parseTaskXml(xml), user)).toBe(true);
  expect(isOwnTask(parseTaskXml(withTrigger('desktop-1\\ZOË CHEN')), user)).toBe(true);
  expect(isOwnTask(parseTaskXml(withTrigger('DESKTOP-1\\Bob')), user)).toBe(false);
  expect(isOwnTask(parseTaskXml(renderTaskXml({ sid: 'S-1-5-21-9', exec, specPath })), user)).toBe(false);
  expect(isOwnTask(undefined, user)).toBe(false);
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

test('the supervisor finds the state file beside the spec it was started with, in either separator', () => {
  expect(serviceStatePathBeside(serviceSpecPath('C:\\L'))).toBe(serviceStatePath('C:\\L'));
  expect(serviceStatePathBeside('/tmp/x/aio-proxy/service.json')).toBe('/tmp/x/aio-proxy/service.state.json');
});
