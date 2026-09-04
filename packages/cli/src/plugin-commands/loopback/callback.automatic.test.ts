import { afterEach, describe, expect, test } from 'bun:test';

import { LoopbackOAuthError, runLoopbackAuthorization } from './index';
import { copy, createDeps, expectPortAvailable, request, resetInteractive, setInteractive } from './test-support';

afterEach(resetInteractive);

describe('loopback automatic callback handling', () => {
  test('checks state before OAuth error and only settles the error with expected state', async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = '';
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return 'https://identity.example/authorize';
        },
      }),
      deps,
    );
    const wrongState = await fetch(`${redirectUri}?error=access_denied&state=wrong-secret`);
    expect(wrongState.status).toBe(400);
    expect(await wrongState.text()).toBe(copy.invalidCallback);
    // The matching-state callback rejects `flow` from inside the request handler, so a rejection
    // handler must already be attached when that request goes out: awaiting the fetch first leaves
    // a microtask checkpoint where the rejection is unhandled, which fails the run intermittently.
    const settled = flow.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((await fetch(`${redirectUri}?error=access_denied&state=expected-state`)).status).toBe(400);
    expect(await settled).toBeInstanceOf(LoopbackOAuthError);
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });

  test('keeps waiting after an invalid automatic callback and accepts a later valid callback', async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = '';
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return 'https://identity.example/authorize';
        },
      }),
      deps,
    );
    const wrongPath = await fetch(`${new URL(redirectUri).origin}/wrong?code=secret&state=expected-state`);
    expect(wrongPath.status).toBe(404);
    expect(await wrongPath.text()).toBe(copy.notFound);
    const wrongState = await fetch(`${redirectUri}?code=secret&state=wrong-secret`);
    expect(wrongState.status).toBe(400);
    expect(await wrongState.text()).toBe(copy.invalidCallback);
    expect((await fetch(`${redirectUri}?code=valid&state=expected-state`)).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ code: 'valid' });
  });

  test('missing code returns a safe error without settling and a later valid callback succeeds', async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = '';
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return 'https://identity.example/authorize';
        },
      }),
      deps,
    );
    const missingCode = await fetch(`${redirectUri}?state=expected-state`);
    expect(missingCode.status).toBe(400);
    expect(await missingCode.text()).not.toContain('expected-state');
    expect((await fetch(`${redirectUri}?code=valid&state=expected-state`)).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ code: 'valid' });
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });
});
