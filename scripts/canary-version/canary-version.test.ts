import { expect, test } from 'bun:test';

import { canaryVersion } from './canary-version';

const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const canary = canaryVersion({ base: '0.23.0', runNumber: '4213', sha });

test('canary 排在 base 之上、下一个正式版之下', () => {
  // 若 canary 排在 base 之下，`aio-proxy@canary` 会显得比 latest 旧，
  // update-notify 会反过来劝 canary 用户“升级”到已发布的 base。
  expect(Bun.semver.order(canary, '0.23.0')).toBe(1);
  expect(Bun.semver.order(canary, '0.23.1')).toBe(-1);
  expect(Bun.semver.order(canary, '0.24.0')).toBe(-1);
});

test('同一 base 下 run number 递增则版本递增', () => {
  const earlier = canaryVersion({ base: '0.23.0', runNumber: '9', sha });
  const later = canaryVersion({ base: '0.23.0', runNumber: '10', sha });
  expect(Bun.semver.order(later, earlier)).toBe(1);
});

test('sha 截断到 7 位并保留在版本里以便追溯', () => {
  expect(canary).toContain('ga1b2c3d');
  expect(canary).not.toContain(sha);
});

test('数字标识符不带前导零', () => {
  // semver 规定数字型 prerelease 标识符不得有前导零，否则版本非法。
  expect(canaryVersion({ base: '0.23.0', runNumber: '007', sha })).toContain('.7.');

  // 七位十六进制有约 0.2% 概率全为数字且首位为 0，裸写入就是一个带前导零的
  // 数字型标识符。`g` 前缀让它始终是字母数字标识符，Bun.semver 才肯排序。
  const digits = canaryVersion({ base: '0.23.0', runNumber: '1', sha: '0123456789abcdef0123456789abcdef01234567' });
  expect(digits).toBe('0.23.1-canary.1.g0123456');
  expect(Bun.semver.order(digits, '0.23.0')).toBe(1);
});

test('拒绝非法 base、run number 与 sha', () => {
  expect(() => canaryVersion({ base: '0.23', runNumber: '1', sha })).toThrow();
  expect(() => canaryVersion({ base: '0.23.0-canary.1.abc1234', runNumber: '1', sha })).toThrow();
  expect(() => canaryVersion({ base: '0.23.0', runNumber: '', sha })).toThrow();
  expect(() => canaryVersion({ base: '0.23.0', runNumber: 'abc', sha })).toThrow();
  expect(() => canaryVersion({ base: '0.23.0', runNumber: '1', sha: 'nothex' })).toThrow();
});
