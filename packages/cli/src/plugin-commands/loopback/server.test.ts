import { afterEach, describe, expect, test } from 'bun:test';

import { AuthorizationUrlInvalidError, LoopbackAbortedError, runLoopbackAuthorization } from './index';
import {
  authorizationCapture,
  copy,
  createDeps,
  expectPortAvailable,
  request,
  resetInteractive,
  setInteractive,
} from './test-support';

afterEach(resetInteractive);

async function requireFixedCallbackTestPort(): Promise<void> {
  let probe: ReturnType<typeof Bun.serve> | undefined;
  try {
    probe = Bun.serve({ hostname: '127.0.0.1', port: 1_455, fetch: () => new Response(null) });
  } catch {
    throw new Error('Fixed-callback test requires 127.0.0.1:1455 to be free; release the listener and retry.');
  } finally {
    await probe?.stop(true);
  }
}

describe('loopback server lifecycle', () => {
  test('binds before building and opening a fixed callback URL, then stops after automatic success', async () => {
    await requireFixedCallbackTestPort();
    setInteractive(false);
    const created = createDeps();
    let listenerWasBound = false;
    let flow: ReturnType<typeof runLoopbackAuthorization> | undefined;
    try {
      flow = runLoopbackAuthorization(
        request({
          redirect: { hostname: 'localhost', port: 1_455, path: '/auth/callback' },
          authorizationUrl: ({ redirectUri }) => {
            expect(redirectUri).toBe('http://localhost:1455/auth/callback');
            expect(() => Bun.serve({ hostname: '127.0.0.1', port: 1_455, fetch: () => new Response(null) })).toThrow();
            listenerWasBound = true;
            return 'https://identity.example/authorize';
          },
        }),
        created.deps,
      );
      expect(listenerWasBound).toBe(true);
      expect(created.opened).toEqual(['https://identity.example/authorize']);
      expect(created.printed).toEqual(['https://identity.example/authorize', copy.openedAuthorizationPage]);
      const response = await fetch('http://localhost:1455/auth/callback?code=auto-code&state=expected-state');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toBe(copy.successHtml);
      await expect(flow).resolves.toEqual({ code: 'auto-code', redirectUri: 'http://localhost:1455/auth/callback' });
    } finally {
      created.controller.abort();
      await flow?.catch(() => {});
      await expectPortAvailable(1_455);
    }
  });

  test('prints the authorization URL and automatic callback succeeds when browser opening returns false', async () => {
    setInteractive(false);
    const authorizationUrl = 'https://identity.example/authorize?flow=browser-false';
    const created = createDeps({ openBrowser: () => false });
    const captured = authorizationCapture(authorizationUrl);
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), created.deps);
    expect(created.printed).toEqual([authorizationUrl]);
    expect((await fetch(`${captured.redirectUri}?code=auto-code&state=expected-state`)).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ code: 'auto-code' });
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });

  test('prints the authorization URL and manual callback succeeds when browser opening throws', async () => {
    setInteractive(true);
    const authorizationUrl = 'https://identity.example/authorize?flow=browser-throw';
    const captured = authorizationCapture(authorizationUrl);
    const created = createDeps({
      openBrowser: () => {
        throw new Error('private browser failure');
      },
      readManualCallbackUrl: async () => `${captured.redirectUri}?code=manual-code&state=expected-state`,
    });
    await expect(
      runLoopbackAuthorization(
        request({
          allowManualCallbackUrl: true,
          authorizationUrl: captured.authorizationUrl,
        }),
        created.deps,
      ),
    ).resolves.toMatchObject({ code: 'manual-code' });
    expect(created.printed).toEqual([authorizationUrl]);
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });

  test('allocates a dynamic port and uses the actual port in the redirect URI', async () => {
    setInteractive(false);
    const { deps, controller } = createDeps();
    const captured = authorizationCapture();
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), deps);
    const parsed = new URL(captured.redirectUri);
    expect(parsed.hostname).toBe('localhost');
    expect(Number(parsed.port)).toBeGreaterThan(0);
    controller.abort();
    await expect(flow).rejects.toBeInstanceOf(LoopbackAbortedError);
    await expectPortAvailable(Number(parsed.port));
  });

  test('rejects a non-HTTP authorization URL without browser invocation and stops the listener', async () => {
    setInteractive(false);
    const { deps, opened } = createDeps();
    const captured = authorizationCapture('file:///tmp/oauth');
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), deps);
    await expect(flow).rejects.toBeInstanceOf(AuthorizationUrlInvalidError);
    expect(opened).toEqual([]);
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });
});
