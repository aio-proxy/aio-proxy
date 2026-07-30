import { expect, test } from 'bun:test';

import { renderLaunchdPlist, renderSystemdUnit } from './service';

test('systemd unit runs `run`, restarts on failure, skips exit 1', () => {
  const unit = renderSystemdUnit({ exec: '/usr/local/bin/aio-proxy', configPath: '/home/u/.aio-proxy/config.jsonc' });
  expect(unit).toContain('ExecStart=/usr/local/bin/aio-proxy run');
  expect(unit).toContain('Restart=on-failure');
  expect(unit).toContain('RestartPreventExitStatus=1');
});

test('launchd plist runs `run` and keeps alive except on clean exit', () => {
  const plist = renderLaunchdPlist({
    exec: '/usr/local/bin/aio-proxy',
    configPath: '/Users/u/.aio-proxy/config.jsonc',
  });
  expect(plist).toContain('<string>run</string>');
  expect(plist).toContain('SuccessfulExit');
});
