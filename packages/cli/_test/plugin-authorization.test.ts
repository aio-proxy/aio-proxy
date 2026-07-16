import { afterEach, describe, expect, test } from "bun:test";
import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";
import { type CliAuthorizationDeps, createCliAuthorizationPort } from "../src/plugin-commands/authorization";
import {
  AuthorizationUrlInvalidError,
  LoopbackAbortedError,
  LoopbackCallbackMismatchError,
  LoopbackOAuthError,
  LoopbackPortUnavailableError,
  LoopbackRequestInvalidError,
  LoopbackStateMismatchError,
  LoopbackTimeoutError,
  runLoopbackAuthorization,
} from "../src/plugin-commands/loopback";

const copy = {
  copiedDeviceCode: "Copied device code.",
  deviceCode: (code: string) => `Device code: ${code}`,
  openedAuthorizationPage: "Opened authorization page.",
  successHtml: "<html><body>Authorization complete.</body></html>",
  alreadyCompleted: "Authorization already completed (test copy).",
  invalidCallback: "Invalid OAuth callback (test copy).",
  notFound: "Not found (test copy).",
} as const;

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(() => {
  if (originalIsTTY === undefined) {
    Reflect.deleteProperty(process.stdin, "isTTY");
  } else {
    Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
  }
});

function setInteractive(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

function pendingManual(_authorizationUrl: string, signal: AbortSignal): Promise<string> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(signal.reason);
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function createDeps(overrides: Partial<CliAuthorizationDeps> = {}): {
  readonly controller: AbortController;
  readonly deps: CliAuthorizationDeps;
  readonly opened: string[];
  readonly printed: string[];
} {
  const controller = new AbortController();
  const opened: string[] = [];
  const printed: string[] = [];
  return {
    controller,
    opened,
    printed,
    deps: {
      copy,
      openBrowser: (url) => {
        opened.push(url);
        return true;
      },
      copyToClipboard: () => true,
      print: (message) => printed.push(message),
      readManualCallbackUrl: pendingManual,
      confirmManualOnly: async () => false,
      signal: controller.signal,
      ...overrides,
    },
  };
}

function request(overrides: Partial<LoopbackRequest> = {}): LoopbackRequest {
  return {
    state: "expected-state",
    redirect: {
      hostname: "localhost",
      port: "dynamic",
      path: "/auth/callback",
    },
    authorizationUrl: ({ redirectUri }) =>
      `https://identity.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
    allowManualCallbackUrl: false,
    ...overrides,
  };
}

async function expectPortAvailable(port: number): Promise<void> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response(null, { status: 204 }),
  });
  await probe.stop(true);
}

async function requireFixedCallbackTestPort(): Promise<void> {
  let probe: ReturnType<typeof Bun.serve> | undefined;
  try {
    probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 1_455,
      fetch: () => new Response(null, { status: 204 }),
    });
  } catch {
    throw new Error(
      "Task 6 fixed-callback test requires 127.0.0.1:1455 to be free before the test; release the external listener and retry.",
    );
  } finally {
    await probe?.stop(true);
  }
}

describe("device-code presentation", () => {
  test("opens and always prints the complete verification URL", async () => {
    const { deps, opened, printed } = createDeps();

    await createCliAuthorizationPort(deps).presentDeviceCode({
      url: "https://identity.example/device?user_code=A%20B",
      userCode: "A B",
      instructions: "Finish in the browser.",
    });

    expect(opened).toEqual(["https://identity.example/device?user_code=A%20B"]);
    expect(printed).toEqual([
      "Copied device code.",
      "Opened authorization page.",
      "https://identity.example/device?user_code=A%20B",
      "Finish in the browser.",
    ]);
  });

  test("resolves localized device instructions at presentation time", async () => {
    const { deps, printed } = createDeps({ copyToClipboard: () => false, openBrowser: () => false });

    await createCliAuthorizationPort({ ...deps, locale: "zh-Hans" }).presentDeviceCode({
      url: "https://identity.example/device",
      userCode: "SAFE-CODE",
      instructions: { default: "Finish in browser", "zh-Hans": "请在浏览器中完成" },
    });

    expect(printed).toEqual(["Device code: SAFE-CODE", "https://identity.example/device", "请在浏览器中完成"]);
  });

  test("contains malformed, accessor-backed, and throwing runtime instructions", async () => {
    let reads = 0;
    const accessor = { default: "Default" };
    Object.defineProperty(accessor, "zh-Hans", {
      enumerable: true,
      get() {
        reads += 1;
        return "must not print";
      },
    });
    const throwing = new Proxy(
      { default: "Default" },
      {
        get() {
          throw new Error("plugin getter failure");
        },
        getOwnPropertyDescriptor() {
          throw new Error("plugin descriptor failure");
        },
      },
    );
    const values = [{ "zh-Hans": "missing default" }, accessor, throwing];

    for (const instructions of values) {
      const { deps, printed } = createDeps({ copyToClipboard: () => false, openBrowser: () => false });
      await expect(
        createCliAuthorizationPort({ ...deps, locale: "zh-Hans" }).presentDeviceCode({
          url: "https://identity.example/device",
          userCode: "SAFE-CODE",
          instructions: instructions as never,
        }),
      ).resolves.toBeUndefined();
      expect(printed).toEqual(["Device code: SAFE-CODE", "https://identity.example/device"]);
    }
    expect(reads).toBe(0);
  });

  test("prints the user code when clipboard copy fails without failing authorization", async () => {
    const { deps, printed } = createDeps({ copyToClipboard: () => false, openBrowser: () => false });

    await createCliAuthorizationPort(deps).presentDeviceCode({
      url: "http://identity.example/device",
      userCode: "SAFE-CODE",
    });

    expect(printed).toEqual(["Device code: SAFE-CODE", "http://identity.example/device"]);
  });

  test("treats clipboard and browser exceptions as presentation failures and still prints the URL", async () => {
    const { deps, printed } = createDeps({
      copyToClipboard: () => {
        throw new Error("clipboard details");
      },
      openBrowser: () => {
        throw new Error("browser details");
      },
    });

    await createCliAuthorizationPort(deps).presentDeviceCode({
      url: "https://identity.example/device",
      userCode: "SAFE-CODE",
    });

    expect(printed).toEqual(["Device code: SAFE-CODE", "https://identity.example/device"]);
  });

  test("rejects a non-HTTP verification URL before opening a browser", async () => {
    const { deps, opened, printed } = createDeps();

    await expect(
      createCliAuthorizationPort(deps).presentDeviceCode({
        url: "javascript:alert(1)",
        userCode: "SECRET",
      }),
    ).rejects.toBeInstanceOf(AuthorizationUrlInvalidError);
    expect(opened).toEqual([]);
    expect(printed).toEqual([]);
  });
});

describe("loopback authorization", () => {
  test("binds before building and opening a fixed callback URL, then stops after automatic success", async () => {
    await requireFixedCallbackTestPort();
    setInteractive(false);
    const created = createDeps();
    let listenerWasBound = false;
    let flow: Promise<{ readonly code: string; readonly redirectUri: string }> | undefined;
    try {
      flow = runLoopbackAuthorization(
        request({
          redirect: { hostname: "localhost", port: 1_455, path: "/auth/callback" },
          authorizationUrl: ({ redirectUri }) => {
            expect(redirectUri).toBe("http://localhost:1455/auth/callback");
            expect(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 1_455,
                fetch: () => new Response(null),
              }),
            ).toThrow();
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
      await expect(flow).resolves.toEqual({
        code: "auto-code",
        redirectUri: "http://localhost:1455/auth/callback",
      });
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
    let redirectUri = "";
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return authorizationUrl;
        },
      }),
      created.deps,
    );

    expect(created.printed).toEqual([authorizationUrl]);
    expect((await fetch(`${redirectUri}?code=auto-code&state=expected-state`)).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ code: "auto-code" });
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });

  test("prints the authorization URL and manual callback succeeds when browser opening throws", async () => {
    setInteractive(true);
    const authorizationUrl = "https://identity.example/authorize?flow=browser-throw";
    let redirectUri = "";
    const created = createDeps({
      openBrowser: () => {
        throw new Error("private browser failure");
      },
      readManualCallbackUrl: async () => `${redirectUri}?code=manual-code&state=expected-state`,
    });

    await expect(
      runLoopbackAuthorization(
        request({
          allowManualCallbackUrl: true,
          authorizationUrl: (input) => {
            redirectUri = input.redirectUri;
            return authorizationUrl;
          },
        }),
        created.deps,
      ),
    ).resolves.toMatchObject({ code: "manual-code" });
    expect(created.printed).toEqual([authorizationUrl]);
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });

  test("allocates a dynamic port and uses the actual port in the redirect URI", async () => {
    setInteractive(false);
    const { deps, controller } = createDeps();
    let redirectUri = "";
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    const parsed = new URL(redirectUri);
    expect(parsed.hostname).toBe("localhost");
    expect(Number(parsed.port)).toBeGreaterThan(0);
    controller.abort();
    await expect(flow).rejects.toBeInstanceOf(LoopbackAbortedError);
    await expectPortAvailable(Number(parsed.port));
  });

  test("rejects a non-HTTP authorization URL without browser invocation and stops the listener", async () => {
    setInteractive(false);
    const { deps, opened } = createDeps();
    let port = 0;
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: ({ redirectUri }) => {
          port = Number(new URL(redirectUri).port);
          return "file:///tmp/oauth";
        },
      }),
      deps,
    );

    await expect(flow).rejects.toBeInstanceOf(AuthorizationUrlInvalidError);
    expect(opened).toEqual([]);
    await expectPortAvailable(port);
  });

  test("accepts a manually pasted complete callback URL", async () => {
    setInteractive(true);
    let redirectUri = "";
    const { deps } = createDeps({
      readManualCallbackUrl: async () => `${redirectUri}?code=manual-code&state=expected-state`,
    });

    await expect(
      runLoopbackAuthorization(
        request({
          allowManualCallbackUrl: true,
          authorizationUrl: (input) => {
            redirectUri = input.redirectUri;
            return "https://identity.example/authorize";
          },
        }),
        deps,
      ),
    ).resolves.toEqual({ code: "manual-code", redirectUri: expect.any(String) });
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });

  test("reports safe manual callback errors and retries until a valid URL is pasted", async () => {
    setInteractive(true);
    const secret = "secret-code-and-state";
    let redirectUri = "";
    const values = [
      `https://attacker.example/callback?code=${secret}&state=${secret}`,
      () => `${redirectUri}?code=manual-code&state=expected-state`,
    ];
    const { deps, printed } = createDeps({
      readManualCallbackUrl: async () => {
        const value = values.shift();
        return typeof value === "function" ? value() : (value ?? "");
      },
    });

    await runLoopbackAuthorization(
      request({
        allowManualCallbackUrl: true,
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    expect(printed).toHaveLength(3);
    expect(printed[0]).toContain("https://identity.example/authorize");
    expect(printed[1]).toBe(copy.openedAuthorizationPage);
    expect(printed[2]).toBe(new LoopbackCallbackMismatchError().message);
    expect(printed.join(" ")).not.toContain(secret);
  });

  test.each([
    [
      "scheme",
      (uri: URL) => `https://${uri.host}${uri.pathname}?code=x&state=expected-state`,
      LoopbackCallbackMismatchError,
    ],
    [
      "hostname",
      (uri: URL) => `http://127.0.0.2:${uri.port}${uri.pathname}?code=x&state=expected-state`,
      LoopbackCallbackMismatchError,
    ],
    [
      "port",
      (uri: URL) => `http://${uri.hostname}:1${uri.pathname}?code=x&state=expected-state`,
      LoopbackCallbackMismatchError,
    ],
    ["path", (uri: URL) => `${uri.origin}/wrong?code=x&state=expected-state`, LoopbackCallbackMismatchError],
    ["state", (uri: URL) => `${uri.href}?code=x&state=wrong`, LoopbackStateMismatchError],
  ] as const)("rejects a manual callback with a mismatched %s and retries", async (_name, invalid, ErrorType) => {
    setInteractive(true);
    let redirectUri = "";
    let calls = 0;
    const { deps, printed } = createDeps({
      readManualCallbackUrl: async () => {
        calls += 1;
        const uri = new URL(redirectUri);
        return calls === 1 ? invalid(uri) : `${uri.href}?code=valid&state=expected-state`;
      },
    });

    const result = await runLoopbackAuthorization(
      request({
        allowManualCallbackUrl: true,
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    expect(result.code).toBe("valid");
    expect(printed[0]).toContain("https://identity.example/authorize");
    expect(printed[1]).toBe(copy.openedAuthorizationPage);
    expect(printed[2]).toBe(new ErrorType().message);
  });

  test("checks state before OAuth error and only settles the error with expected state", async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = "";
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    const wrongState = await fetch(`${redirectUri}?error=access_denied&state=wrong-secret`);
    expect(wrongState.status).toBe(400);
    expect(await wrongState.text()).toBe(copy.invalidCallback);
    const acceptedError = await fetch(`${redirectUri}?error=access_denied&state=expected-state`);
    expect(acceptedError.status).toBe(400);
    await expect(flow).rejects.toBeInstanceOf(LoopbackOAuthError);
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });

  test("keeps waiting after an invalid automatic callback and accepts a later valid callback", async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = "";
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return "https://identity.example/authorize";
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
    await expect(flow).resolves.toMatchObject({ code: "valid" });
  });

  test("a valid automatic callback wins the race and aborts manual input", async () => {
    setInteractive(true);
    let redirectUri = "";
    let manualWasAborted = false;
    const { deps } = createDeps({
      readManualCallbackUrl: (_url, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              manualWasAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    const flow = runLoopbackAuthorization(
      request({
        allowManualCallbackUrl: true,
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    await fetch(`${redirectUri}?code=auto-wins&state=expected-state`);
    await expect(flow).resolves.toMatchObject({ code: "auto-wins" });
    expect(manualWasAborted).toBe(true);
  });

  test("manual first valid result wins and late automatic callbacks cannot resettle", async () => {
    setInteractive(true);
    let redirectUri = "";
    const { deps } = createDeps({
      readManualCallbackUrl: async () => `${redirectUri}?code=manual-wins&state=expected-state`,
    });
    const flow = runLoopbackAuthorization(
      request({
        allowManualCallbackUrl: true,
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    const result = await flow;
    expect(result.code).toBe("manual-wins");
    const lateCallbacks = await Promise.allSettled([
      fetch(`${redirectUri}?code=late-auto-1&state=expected-state`),
      fetch(`${redirectUri}?code=late-auto-2&state=expected-state`),
    ]);
    expect(lateCallbacks.every(({ status }) => status === "rejected")).toBe(true);
    expect(result.code).toBe("manual-wins");
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });

  test("missing code returns a safe error without settling and a later valid callback succeeds", async () => {
    setInteractive(false);
    const { deps } = createDeps();
    let redirectUri = "";
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: (input) => {
          redirectUri = input.redirectUri;
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    const missingCode = await fetch(`${redirectUri}?state=expected-state`);
    expect(missingCode.status).toBe(400);
    expect(await missingCode.text()).not.toContain("expected-state");
    expect((await fetch(`${redirectUri}?code=valid&state=expected-state`)).status).toBe(200);
    await expect(flow).resolves.toMatchObject({ code: "valid" });
    await expectPortAvailable(Number(new URL(redirectUri).port));
  });

  test("aborts and stops the listener", async () => {
    setInteractive(false);
    const { deps, controller } = createDeps();
    let port = 0;
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: ({ redirectUri }) => {
          port = Number(new URL(redirectUri).port);
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    controller.abort(new Error("private abort reason"));
    await expect(flow).rejects.toBeInstanceOf(LoopbackAbortedError);
    await expectPortAvailable(port);
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
            return "https://identity.example/authorize";
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
    let port = 0;
    const flow = runLoopbackAuthorization(
      request({
        authorizationUrl: ({ redirectUri }) => {
          port = Number(new URL(redirectUri).port);
          return "https://identity.example/authorize";
        },
      }),
      deps,
    );

    await expect(flow).rejects.toBeInstanceOf(LoopbackTimeoutError);
    await expectPortAvailable(port);
  });

  test("fixed-port bind failure only continues after explicit manual-only confirmation", async () => {
    setInteractive(true);
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null),
    });
    const fixedPort = occupied.port;
    const fixedRequest = request({
      redirect: { hostname: "localhost", port: fixedPort, path: "/auth/callback" },
      allowManualCallbackUrl: true,
    });

    try {
      const denied = createDeps({ confirmManualOnly: async () => false });
      await expect(runLoopbackAuthorization(fixedRequest, denied.deps)).rejects.toBeInstanceOf(
        LoopbackPortUnavailableError,
      );

      let confirmedUri = "";
      const allowed = createDeps({
        confirmManualOnly: async (redirectUri) => {
          confirmedUri = redirectUri;
          return true;
        },
        readManualCallbackUrl: async () => `${confirmedUri}?code=manual-only&state=expected-state`,
      });
      await expect(runLoopbackAuthorization(fixedRequest, allowed.deps)).resolves.toEqual({
        code: "manual-only",
        redirectUri: `http://localhost:${fixedPort}/auth/callback`,
      });
      expect(confirmedUri).toBe(`http://localhost:${fixedPort}/auth/callback`);
    } finally {
      await occupied.stop(true);
    }
  });

  test.each([
    ["null request", null],
    ["missing request fields", {}],
    ["non-string state", { ...request(), state: null }],
    ["empty state", request({ state: "" })],
    ["missing redirect", { ...request(), redirect: undefined }],
    ["non-string hostname", { ...request(), redirect: { hostname: 42, port: "dynamic", path: "/auth/callback" } }],
    [
      "non-loopback hostname",
      { ...request(), redirect: { hostname: "attacker.example", port: "dynamic", path: "/auth/callback" } },
    ],
    ["invalid port type", { ...request(), redirect: { hostname: "localhost", port: null, path: "/auth/callback" } }],
    ["invalid port range", { ...request(), redirect: { hostname: "localhost", port: 0, path: "/auth/callback" } }],
    ["non-string path", { ...request(), redirect: { hostname: "localhost", port: "dynamic", path: null } }],
    ["path without slash", { ...request(), redirect: { hostname: "localhost", port: "dynamic", path: "callback" } }],
    [
      "path with query",
      { ...request(), redirect: { hostname: "localhost", port: "dynamic", path: "/callback?secret=x" } },
    ],
    [
      "path with fragment",
      { ...request(), redirect: { hostname: "localhost", port: "dynamic", path: "/callback#secret" } },
    ],
    ["non-function authorization URL builder", { ...request(), authorizationUrl: "https://identity.example" }],
    ["non-boolean manual callback flag", { ...request(), allowManualCallbackUrl: "yes" }],
  ] as const)("rejects invalid loopback request input with a safe typed error: %s", async (_name, value) => {
    let clockCalls = 0;
    const created = createDeps({
      now: () => {
        clockCalls += 1;
        return clockCalls === 1 ? 0 : 10 * 60_000 + 1;
      },
    });
    await expect(runLoopbackAuthorization(value as LoopbackRequest, created.deps)).rejects.toBeInstanceOf(
      LoopbackRequestInvalidError,
    );
    expect(created.opened).toEqual([]);
  });
});
