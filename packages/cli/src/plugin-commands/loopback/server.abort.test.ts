import { afterEach, describe, expect, test } from 'bun:test';

import { LoopbackAbortedError, LoopbackTimeoutError, runLoopbackAuthorization } from './index';
import {
  authorizationCapture,
  createDeps,
  expectPortAvailable,
  request,
  resetInteractive,
  setInteractive,
} from './test-support';

afterEach(resetInteractive);

describe('loopback server abort and timeout', () => {
  test('aborts and stops the listener', async () => {
    setInteractive(false);
    const { deps, controller } = createDeps();
    const captured = authorizationCapture();
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), deps);
    controller.abort(new Error('private abort reason'));
    await expect(flow).rejects.toBeInstanceOf(LoopbackAbortedError);
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });

  test('does not build or open authorization when already aborted', async () => {
    setInteractive(false);
    let built = false;
    const created = createDeps();
    created.controller.abort();
    await expect(
      runLoopbackAuthorization(
        request({
          authorizationUrl: () => {
            built = true;
            return 'https://identity.example';
          },
        }),
        created.deps,
      ),
    ).rejects.toBeInstanceOf(LoopbackAbortedError);
    expect(built).toBe(false);
    expect(created.opened).toEqual([]);
  });

  test('does not open the browser when authorization is aborted while building the URL', async () => {
    setInteractive(false);
    const created = createDeps();
    let port = 0;
    await expect(
      runLoopbackAuthorization(
        request({
          authorizationUrl: ({ redirectUri }) => {
            port = Number(new URL(redirectUri).port);
            created.controller.abort();
            return 'https://identity.example/authorize';
          },
        }),
        created.deps,
      ),
    ).rejects.toBeInstanceOf(LoopbackAbortedError);
    expect(created.opened).toEqual([]);
    await expectPortAvailable(port);
  });

  test('times out using the injected clock and stops the listener', async () => {
    setInteractive(false);
    let clockCalls = 0;
    const { deps } = createDeps({
      now: () => {
        clockCalls += 1;
        return clockCalls === 1 ? 0 : 10 * 60_000 + 1;
      },
    });
    const captured = authorizationCapture();
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), deps);
    await expect(flow).rejects.toBeInstanceOf(LoopbackTimeoutError);
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });
});
