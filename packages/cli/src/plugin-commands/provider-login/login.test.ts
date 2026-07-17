import { afterEach, describe, expect, test } from "bun:test";
import { AccountCleanupPendingError, type AtomicConfigFile } from "@aio-proxy/core";
import { createProviderLoginDefaultDeps, providerLogin } from "./index";
import { createProviderLoginTestScope } from "./test-support";

const scope = createProviderLoginTestScope();
afterEach(scope.cleanup);

describe("provider login orchestration", () => {
  test("accepts canonical references and persists canonical plugin/capability", async () => {
    const state = scope.fixture();
    await providerLogin("@a/one#unique", {}, state.deps);
    expect(state.calls[0]).toBe("recover");
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@a/one", capability: "unique" } });
    expect(state.printed).toEqual(["created"]);
  });

  test("--provider infers the structured canonical capability and explicit mismatch fails", async () => {
    const provider = { kind: "oauth", plugin: "@a/one", capability: "unique", enabled: true };
    const state = scope.fixture(provider);
    await providerLogin(undefined, { provider: "target" }, state.deps);
    expect(state.calls[1]).toMatchObject({
      targetProviderId: "target",
      capability: { plugin: "@a/one", capability: "unique" },
    });
    await expect(providerLogin("@b/two#default", { provider: "target" }, state.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "Requested capability @b/two#default does not match provider capability @a/one#unique.",
    });
  });

  test("distinguishes missing, invalid, and cleanup-pending provider targets", async () => {
    const state = scope.fixture();
    await expect(providerLogin(undefined, { provider: "target" }, state.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "OAuth provider target was not found.",
    });
    const invalid = scope.fixture({ kind: "api", protocol: "openai-compatible" });
    await expect(providerLogin(undefined, { provider: "target" }, invalid.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "Provider target is not a valid OAuth provider.",
    });
    const pending = scope.fixture({ kind: "oauth", plugin: "@a/one", capability: "unique", enabled: true });
    pending.deps = {
      ...pending.deps,
      login: async () => {
        throw new AccountCleanupPendingError("target");
      },
    };
    await expect(providerLogin(undefined, { provider: "target" }, pending.deps)).rejects.toThrow(
      "Provider target is pending account cleanup.",
    );
    await expect(providerLogin("@missing/pkg#default", {}, state.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "OAuth capability @missing/pkg#default was not found.",
    });
    const unavailable = scope.fixture({ kind: "oauth", plugin: "@missing/pkg", capability: "default", enabled: true });
    await expect(providerLogin(undefined, { provider: "target" }, unavailable.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "OAuth capability @missing/pkg#default was not found.",
    });
  });

  test("default dependency creation closes SQLite when registry loading fails", async () => {
    let closes = 0;
    await expect(
      createProviderLoginDefaultDeps({
        config: { read: async () => ({ plugins: [], providers: {} }) } as AtomicConfigFile,
        openDatabase: () => ({ sqlite: {}, close: () => (closes += 1) }) as never,
        createRepository: () => ({ readPluginSecret: () => null }) as never,
        loadRegistry: async () => {
          throw new Error("setup failed");
        },
      }),
    ).rejects.toThrow("setup failed");
    expect(closes).toBe(1);
  });
});
