import { afterEach, describe, expect, test } from "bun:test";
import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";
import { type CliAuthorizationDeps, createCliAuthorizationPort } from "../src/plugin-commands/authorization";
import {
  AuthorizationUrlInvalidError,
  LoopbackAbortedError,
  LoopbackCallbackMismatchError,
  LoopbackOAuthError,
  LoopbackPortUnavailableError,
  LoopbackStateMismatchError,
  LoopbackTimeoutError,
  runLoopbackAuthorization,
} from "../src/plugin-commands/loopback";

const copy = {
  copiedDeviceCode: "Copied device code.",
  deviceCode: (code: string) => `Device code: ${code}`,
  openedAuthorizationPage: "Opened authorization page.",
  successHtml: "<html><body>Authorization complete.</body></html>",
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
    setInteractive(false);
    const { deps, opened } = createDeps();
    let listenerWasBound = false;
    const flow = runLoopbackAuthorization(
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
      deps,
    );

    expect(listenerWasBound).toBe(true);
    expect(opened).toEqual(["https://identity.example/authorize"]);
    const callback = "http://localhost:1455/auth/callback?code=auto-code&state=expected-state";
    const responses = await Promise.all([fetch(callback), fetch(callback)]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const response = responses.find(({ status }) => status === 200);
    expect(response?.headers.get("content-type")).toContain("text/html");
    expect(await response?.text()).toBe(copy.successHtml);
    await expect(flow).resolves.toEqual({
      code: "auto-code",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    await expectPortAvailable(1_455);
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

    expect(printed).toHaveLength(1);
    expect(printed[0]).toBe(new LoopbackCallbackMismatchError().message);
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
    expect(printed).toEqual([new ErrorType().message]);
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

    expect((await fetch(`${new URL(redirectUri).origin}/wrong?code=secret&state=expected-state`)).status).toBe(404);
    expect((await fetch(`${redirectUri}?code=secret&state=wrong-secret`)).status).toBe(400);
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

  test("the first valid manual result wins and a duplicate automatic callback cannot resettle", async () => {
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

    await expect(flow).resolves.toMatchObject({ code: "manual-wins" });
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
    ["empty state", { state: "" }],
    ["invalid port", { redirect: { hostname: "localhost", port: 0, path: "/auth/callback" } }],
    ["path without slash", { redirect: { hostname: "localhost", port: "dynamic", path: "callback" as `/${string}` } }],
    ["path with query", { redirect: { hostname: "localhost", port: "dynamic", path: "/callback?secret=x" } }],
    ["path with fragment", { redirect: { hostname: "localhost", port: "dynamic", path: "/callback#secret" } }],
    [
      "non-loopback hostname",
      { redirect: { hostname: "attacker.example" as "localhost", port: "dynamic", path: "/auth/callback" } },
    ],
  ] as const)("rejects invalid loopback request input: %s", async (_name, override) => {
    const { deps, opened } = createDeps();
    await expect(runLoopbackAuthorization(request(override as Partial<LoopbackRequest>), deps)).rejects.toBeInstanceOf(
      Error,
    );
    expect(opened).toEqual([]);
  });
});
