import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";

import { afterEach, describe, expect, test } from "bun:test";

import {
  LoopbackCallbackMismatchError,
  LoopbackOAuthError,
  LoopbackRequestInvalidError,
  LoopbackStateMismatchError,
  runLoopbackAuthorization,
} from "./index";
import { copy, createDeps, expectPortAvailable, request, resetInteractive, setInteractive } from "./test-support";

afterEach(resetInteractive);

describe("loopback callback handling", () => {
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
    expect((await fetch(`${redirectUri}?error=access_denied&state=expected-state`)).status).toBe(400);
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
    const created = createDeps();
    await expect(runLoopbackAuthorization(value as LoopbackRequest, created.deps)).rejects.toBeInstanceOf(
      LoopbackRequestInvalidError,
    );
    expect(created.opened).toEqual([]);
  });
});
