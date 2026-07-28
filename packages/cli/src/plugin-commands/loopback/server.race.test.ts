import { afterEach, describe, expect, test } from 'bun:test';

import { runLoopbackAuthorization } from './index';
import {
  authorizationCapture,
  createDeps,
  expectPortAvailable,
  request,
  resetInteractive,
  setInteractive,
} from './test-support';

afterEach(resetInteractive);

describe('loopback server race resolution', () => {
  test('a valid automatic callback wins the race and aborts manual input', async () => {
    setInteractive(true);
    const captured = authorizationCapture();
    let manualWasAborted = false;
    const { deps } = createDeps({
      readManualCallbackUrl: (_url, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              manualWasAborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
    });
    const flow = runLoopbackAuthorization(
      request({
        allowManualCallbackUrl: true,
        authorizationUrl: captured.authorizationUrl,
      }),
      deps,
    );
    await fetch(`${captured.redirectUri}?code=auto-wins&state=expected-state`);
    await expect(flow).resolves.toMatchObject({ code: 'auto-wins' });
    expect(manualWasAborted).toBe(true);
  });

  test('manual first valid result wins and late automatic callbacks cannot resettle', async () => {
    setInteractive(true);
    const captured = authorizationCapture();
    const { deps } = createDeps({
      readManualCallbackUrl: async () => `${captured.redirectUri}?code=manual-wins&state=expected-state`,
    });
    const result = await runLoopbackAuthorization(
      request({
        allowManualCallbackUrl: true,
        authorizationUrl: captured.authorizationUrl,
      }),
      deps,
    );
    expect(result.code).toBe('manual-wins');
    const late = await Promise.allSettled(
      [1, 2].map((n) => fetch(`${captured.redirectUri}?code=late-${n}&state=expected-state`)),
    );
    expect(late.every((entry) => entry.status === 'rejected' || !entry.value.ok)).toBe(true);
    expect(result.code).toBe('manual-wins');
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });
});
