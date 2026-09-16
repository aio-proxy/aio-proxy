import { expect, test } from 'bun:test';

import { parseVersionOutput } from './version-output';

test('parseVersionOutput keeps the prerelease suffix', () => {
  // 丢掉后缀的话，canary 安装后的校验会拿 `0.23.1` 去比请求的
  // `0.23.1-canary.*`，判定失败并把刚装好的二进制回滚掉。
  expect(parseVersionOutput('aio-proxy 0.23.1-canary.4213.ga1b2c3d')).toBe('0.23.1-canary.4213.ga1b2c3d');
  expect(parseVersionOutput('aio-proxy 0.23.0')).toBe('0.23.0');
  expect(parseVersionOutput('no version here')).toBeUndefined();
});
