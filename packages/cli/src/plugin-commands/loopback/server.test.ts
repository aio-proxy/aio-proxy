import { afterEach, describe, expect, test } from "bun:test";

import {
  AuthorizationUrlInvalidError,
  LoopbackAbortedError,
  LoopbackTimeoutError,
  runLoopbackAuthorization,
} from "./index";
import { copy, createDeps, expectPortAvailable, request, resetInteractive, setInteractive } from "./test-support";

afterEach(resetInteractive);

function authorizationCapture(url = "https://identity.example/authorize") {
  let redirectUri = "";
  return {
    authorizationUrl({ redirectUri: next }: { readonly redirectUri: string }) {
      redirectUri = next;
      return url;
    },
    get redirectUri() {
      return redirectUri;
    },
  };
}

async function requireFixedCallbackTestPort(): Promise<void> {
  let probe: ReturnType<typeof Bun.serve> | undefined;
  try {
    probe = Bun.serve({ hostname: "127.0.0.1", port: 1_455, fetch: () => new Response(null) });
  } catch {
    throw new Error("Fixed-callback test requires 127.0.0.1:1455 to be free; release the listener and retry.");
  } finally {
    await probe?.stop(true);
  }
}

describe("loopback server lifecycle", () => {
  test("binds before building and opening a fixed callback URL, then stops after automatic success", async () => {
    await requireFixedCallbackTestPort();
    setInteractive(false);
    const created = createDeps();
    let listenerWasBound = false;
    let flow: ReturnType<typeof runLoopbackAuthorization> | undefined;
    try {
      flow = runLoopbackAuthorization(
        request({
          redirect: { hostname: "localhost", port: 1_455, path: "/auth/callback" },
          authorizationUrl: ({ redirectUri }) => {
            expect(redirectUri).toBe("http://localhost:1455/auth/callback");
            expect(() => Bun.serve({ hostname: "127.0.0.1", port: 1_455, fetch: () => new Response(null) })).toThrow();
            listenerWasBound = true;
            return "https://identity.example/authorize";
          },
        }),
        created.deps,
      );
      expect(listenerWasBound).toBe(true);
      expect(created.opened).toEqual(["https://identity.example/authorize"]);
      expect(created.printed).toEqual(["https://identity.example/authorize", copy.openedAuthorizationPage]);
      const response = await fetch("http://localhost:1455/auth/callback?code=auto-code&state=expected-state");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toBe(copy.successHtml);
      await expect(flow).resolves.toEqual({ code: "auto-code", redirectUri: "http://localhost:1455/auth/callback" });
    } finally {
      created.controller.abort();
      await flow?.catch(() => {});
      await expectPortAvailable(1_455);
    }
  });

  test("prints the authorization URL and automatic callback succeeds when browser opening returns false", async () => {
    setInteractive(false);
    const authorizationUrl = "https://identity.example/authorize?flow=browser-false";
    const created = createDeps({ openBrowser: () => false });
    const captured = authorizationCapture(authorizationUrl);
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), created.deps);
    expect(created.printed).toEqual([authorizationUrl]);
    expect((await fetch(`${captured.redirectUri}?code=auto-code&state=expected-state`)).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ code: "auto-code" });
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });

  test("prints the authorization URL and manual callback succeeds when browser opening throws", async () => {
    setInteractive(true);
    const authorizationUrl = "https://identity.example/authorize?flow=browser-throw";
    const captured = authorizationCapture(authorizationUrl);
    const created = createDeps({
      openBrowser: () => {
        throw new Error("private browser failure");
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
    ).resolves.toMatchObject({ code: "manual-code" });
    expect(created.printed).toEqual([authorizationUrl]);
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });

  test("allocates a dynamic port and uses the actual port in the redirect URI", async () => {
    setInteractive(false);
    const { deps, controller } = createDeps();
    const captured = authorizationCapture();
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), deps);
    const parsed = new URL(captured.redirectUri);
    expect(parsed.hostname).toBe("localhost");
    expect(Number(parsed.port)).toBeGreaterThan(0);
    controller.abort();
    await expect(flow).rejects.toBeInstanceOf(LoopbackAbortedError);
    await expectPortAvailable(Number(parsed.port));
  });

  test("rejects a non-HTTP authorization URL without browser invocation and stops the listener", async () => {
    setInteractive(false);
    const { deps, opened } = createDeps();
    const captured = authorizationCapture("file:///tmp/oauth");
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), deps);
    await expect(flow).rejects.toBeInstanceOf(AuthorizationUrlInvalidError);
    expect(opened).toEqual([]);
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });

  test("a valid automatic callback wins the race and aborts manual input", async () => {
    setInteractive(true);
    const captured = authorizationCapture();
    let manualWasAborted = false;
    const { deps } = createDeps({
      readManualCallbackUrl: (_url, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
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
    await expect(flow).resolves.toMatchObject({ code: "auto-wins" });
    expect(manualWasAborted).toBe(true);
  });

  test("manual first valid result wins and late automatic callbacks cannot resettle", async () => {
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
    expect(result.code).toBe("manual-wins");
    const late = await Promise.allSettled(
      [1, 2].map((n) => fetch(`${captured.redirectUri}?code=late-${n}&state=expected-state`)),
    );
    expect(late.every(({ status }) => status === "rejected")).toBe(true);
    expect(result.code).toBe("manual-wins");
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });

  test("aborts and stops the listener", async () => {
    setInteractive(false);
    const { deps, controller } = createDeps();
    const captured = authorizationCapture();
    const flow = runLoopbackAuthorization(request({ authorizationUrl: captured.authorizationUrl }), deps);
    controller.abort(new Error("private abort reason"));
    await expect(flow).rejects.toBeInstanceOf(LoopbackAbortedError);
    await expectPortAvailable(Number(new URL(captured.redirectUri).port));
  });

  test("does not build or open authorization when already aborted", async () => {
    setInteractive(false);
    let built = false;
    const created = createDeps();
    created.controller.abort();
    await expect(
      runLoopbackAuthorization(
        request({
          authorizationUrl: () => {
            built = true;
            return "https://identity.example";
          },
        }),
        created.deps,
      ),
    ).rejects.toBeInstanceOf(LoopbackAbortedError);
    expect(built).toBe(false);
    expect(created.opened).toEqual([]);
  });

  test("does not open the browser when authorization is aborted while building the URL", async () => {
    setInteractive(false);
    const created = createDeps();
    let port = 0;
    await expect(
      runLoopbackAuthorization(
        request({
          authorizationUrl: ({ redirectUri }) => {
            port = Number(new URL(redirectUri).port);
            created.controller.abort();
            return "https://identity.example/authorize";
          },
        }),
        created.deps,
      ),
    ).rejects.toBeInstanceOf(LoopbackAbortedError);
    expect(created.opened).toEqual([]);
    await expectPortAvailable(port);
  });

  test("times out using the injected clock and stops the listener", async () => {
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
