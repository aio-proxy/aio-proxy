import { describe, expect, test } from "bun:test";
import { definePlugin } from "@aio-proxy/plugin-sdk";
import { type DiagnosticFactory, redactPluginError } from "../../src/plugins/diagnostic";
import { loadPluginRegistry } from "../../src/plugins/loader";

describe("redactPluginError", () => {
  test("removes OAuth material, URLs, causes, stacks, and arbitrary third-party secrets", () => {
    const thirdPartySecret = "third-party-secret-value";
    const error = new Error(
      `Bearer bearer-value access_token=access-value refresh_token=refresh-value authorization_code=auth-code code=callback-code code_verifier=verifier-value state=oauth-state accessToken=camel-access refreshToken=camel-refresh https://example.test/callback?code=query-code raw=https://example.test/callback?state=query-state ${thirdPartySecret}`,
      { cause: new Error("raw cause") },
    );
    error.stack = `Error: ${error.message}\n at plugin (${thirdPartySecret})`;

    const redacted = redactPluginError(error, { secretValues: [thirdPartySecret] });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "bearer-value",
      "access-value",
      "refresh-value",
      "auth-code",
      "callback-code",
      "verifier-value",
      "oauth-state",
      "camel-access",
      "camel-refresh",
      "query-code",
      "query-state",
      thirdPartySecret,
      "raw cause",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(redacted.name).toBe("Error");
    expect(redacted.message).toContain("[REDACTED]");
    expect(redacted.stack).toContain("[REDACTED]");
    expect(redacted).not.toHaveProperty("cause");
  });

  test("redacts OAuth values from JSON quoted keys", () => {
    const values = {
      access_token: "json-access",
      refresh_token: "json-refresh",
      authorization_code: "json-code",
      code: "json-short-code",
      code_verifier: "json-verifier",
      state: "json-state",
      accessToken: "json-camel-access",
      refreshToken: "json-camel-refresh",
    };
    const error = new Error(JSON.stringify(values));
    error.stack = `Error: ${JSON.stringify(values)}`;

    const serialized = JSON.stringify(redactPluginError(error));
    for (const value of Object.values(values)) expect(serialized).not.toContain(value);
  });

  test("redacts escape-aware JSON string values from message and stack", () => {
    const secrets = ["quote-secret-suffix", "backslash-secret", "state-secret", "second-code-secret"];
    const payload = JSON.stringify({
      access_token: `prefix"${secrets[0]}`,
      refresh_token: `path\\${secrets[1]}`,
      state: secrets[2],
      code: secrets[3],
    });
    const error = new Error(payload);
    error.stack = `Error: ${payload}\n at plugin (plugin.ts:1:1)`;

    const redacted = redactPluginError(error);
    for (const secret of secrets) {
      expect(redacted.message).not.toContain(secret);
      expect(redacted.stack).not.toContain(secret);
    }
  });

  test("malicious error accessors and string conversion use a fixed safe fallback", () => {
    const accessorError = Object.create(Error.prototype, {
      name: {
        get: () => {
          throw new Error("name getter leaked");
        },
      },
      message: {
        get: () => {
          throw new Error("message getter leaked");
        },
      },
      stack: {
        get: () => {
          throw new Error("stack getter leaked");
        },
      },
    });
    const stringError = {
      [Symbol.toPrimitive]() {
        throw new Error("string conversion leaked");
      },
    };

    expect(redactPluginError(accessorError)).toEqual({
      name: "Error",
      message: "Plugin error details unavailable",
    });
    expect(redactPluginError(stringError)).toEqual({
      name: "Error",
      message: "Plugin error details unavailable",
    });
  });

  test("loader diagnostics never receive raw plugin error details", async () => {
    const secret = "public-diagnostic-secret";
    let capturedCode: unknown;
    let capturedOptions: unknown;
    const diagnostics: DiagnosticFactory = (code, options) => {
      capturedCode = code;
      capturedOptions = options;
      return {
        code,
        retryable: options.retryable,
        summary: code,
        occurredAt: new Date(0).toISOString(),
      };
    };
    const error = new Error(`Bearer ${secret}`, { cause: new Error("private cause") });
    error.stack = `Error: Bearer ${secret}\n at plugin (plugin.ts:1:1)`;
    const descriptor = definePlugin(() => {
      throw error;
    });

    const snapshot = await loadPluginRegistry({
      enablements: [],
      builtIns: [{ packageName: "@example/public-diagnostic", version: "1.0.0", descriptor }],
      diagnostics,
      importPackage: async () => {
        throw new Error("must not import");
      },
      logger: () => {},
      secrets: { readPluginSecret: () => undefined },
    });
    const serialized = JSON.stringify(snapshot.plugins.get("@example/public-diagnostic")?.state);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private cause");
    expect(serialized).not.toContain("stack");
    expect(serialized).toContain("PLUGIN_LOAD_FAILED");
    expect(capturedCode).toBe("PLUGIN_LOAD_FAILED");
    expect(capturedOptions).toEqual({ plugin: "@example/public-diagnostic", retryable: false });
    expect(JSON.stringify(capturedOptions)).not.toContain(secret);
    expect(JSON.stringify(capturedOptions)).not.toContain("cause");
    expect(JSON.stringify(capturedOptions)).not.toContain("stack");
    expect(Object.keys(capturedOptions as object).sort()).toEqual(["plugin", "retryable"]);
  });
});
