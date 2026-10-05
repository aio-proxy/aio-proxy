import { expect, test } from 'bun:test';

import { detectPlatform } from './detect-platform';

test('offers each desktop build only to the OS that can run it', () => {
  const cases: [string, number, ReturnType<typeof detectPlatform>][] = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 0, 'macos'],
    // iPadOS reports a Macintosh user agent.
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', 5, undefined],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 5, undefined],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', 0, 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', 0, 'linux-x86_64'],
    ['Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0', 0, 'linux-aarch64'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', 5, undefined],
    ['Mozilla/5.0 (X11; CrOS x86_64 16093.0.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', 0, undefined],
  ];
  for (const [userAgent, touchPoints, expected] of cases) {
    expect([userAgent, detectPlatform(userAgent, touchPoints)]).toEqual([userAgent, expected]);
  }
});
