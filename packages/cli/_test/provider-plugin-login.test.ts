import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountCleanupPendingError,
  AtomicConfigFile,
  createPluginRegistryHost,
  ProviderAccountAlreadyExistsError,
  ProviderIdCollisionError,
} from "@aio-proxy/core";
import type { OAuthAdapter } from "@aio-proxy/plugin-sdk";
import { zod } from "@aio-proxy/plugin-sdk";
import {
  createCapabilitySelector,
  createManualOnlyConfirmation,
  createProviderLoginDefaultDeps,
  ProviderCapabilityAmbiguousError,
  ProviderCapabilityMismatchError,
  ProviderCapabilityNotFoundError,
  type ProviderLoginDeps,
  providerLogin,
} from "../src/plugin-commands/provider-login";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function adapter(id: string): OAuthAdapter {
  return {
    id,
    label: id,
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error("not called");
    },
    catalog: {
      policy: { kind: "static" },
      async discover() {
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
    async createRuntime() {
      throw new Error("not called");
    },
  };
}

function registry() {
  const host = createPluginRegistryHost();
  for (const [plugin, ids] of [
    ["@a/one", ["default", "unique"]],
    ["@b/two", ["default"]],
  ] as const) {
    const staging = host.stage(plugin);
    for (const id of ids) staging.api.oauth.register(adapter(id));
    staging.seal();
    staging.commit();
  }
  return host.registry;
}

function fixture(provider?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "aio-proxy-provider-login-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify({ plugins: [], providers: provider === undefined ? {} : { target: provider } })}\n`,
  );
  const calls: unknown[] = [];
  const printed: string[] = [];
  const deps: ProviderLoginDeps = {
    config: new AtomicConfigFile(path),
    repository: {} as ProviderLoginDeps["repository"],
    registry: registry(),
    isTTY: false,
    selectCapability: async (references) => references[0] as string,
    renderAccountOptions: async () => ({ publicValues: {}, secrets: {} }),
    createAuthorization: () => ({
      async presentDeviceCode() {},
      async loopback() {
        return { code: "c", redirectUri: "http://localhost" };
      },
    }),
    diagnostics: (code, options) => ({
      code,
      summary: code,
      retryable: options.retryable,
      occurredAt: new Date(0).toISOString(),
    }),
    logger: () => {},
    recover: async () => {
      calls.push("recover");
      return {};
    },
    login: async (input) => {
      calls.push(input);
      return { providerId: "created" };
    },
    print: (line) => printed.push(line),
  };
  return { deps, calls, printed };
}

describe("generic provider login capability resolution", () => {
  test("uses localized capability prompt copy", async () => {
    let message: string | undefined;
    const selectCapability = createCapabilitySelector(async (config) => {
      message = config.message;
      return config.choices[0]?.value ?? "";
    });
    await expect(selectCapability(["@a/one#default"])).resolves.toBe("@a/one#default");
    expect(message).toBe("Select an OAuth capability.");
  });

  test("manual-only confirmation uses the login signal", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const confirmManualOnly = createManualOnlyConfirmation(controller.signal, async (_config, context) => {
      observedSignal = context?.signal;
      return true;
    });
    await expect(confirmManualOnly("http://127.0.0.1/callback")).resolves.toBe(true);
    expect(observedSignal).toBe(controller.signal);
  });

  test("accepts canonical references and persists canonical plugin/capability", async () => {
    const state = fixture();
    await providerLogin("@a/one#unique", {}, state.deps);
    expect(state.calls[0]).toBe("recover");
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@a/one", capability: "unique" } });
    expect(state.printed).toEqual(["created"]);
  });

  test("resolves an unambiguous short capability ID", async () => {
    const state = fixture();
    await providerLogin("unique", {}, state.deps);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@a/one", capability: "unique" } });
  });

  test("lists canonical ambiguity choices in non-interactive mode", async () => {
    const state = fixture();
    await expect(providerLogin("default", {}, state.deps)).rejects.toMatchObject({
      name: "ProviderCapabilityAmbiguousError",
      message: "OAuth capability default is ambiguous. Choose one of: @a/one#default, @b/two#default.",
      references: ["@a/one#default", "@b/two#default"],
    });
    expect(new ProviderCapabilityAmbiguousError("default", ["@a/one#default"]).references).toEqual(["@a/one#default"]);
  });

  test("uses localized capability and target errors with safe identifiers", async () => {
    expect(new ProviderCapabilityNotFoundError("missing").message).toBe("OAuth capability missing was not found.");
    expect(new ProviderCapabilityMismatchError("@a/one#unique", "@b/two#default").message).toBe(
      "Requested capability @a/one#unique does not match provider capability @b/two#default.",
    );
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new AccountCleanupPendingError("target");
      },
    };
    await expect(providerLogin("unique", {}, state.deps)).rejects.toThrow(
      "Provider target is pending account cleanup.",
    );
  });

  test("localizes exhausted Provider ID collisions with the safe candidate", async () => {
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new ProviderIdCollisionError("person-deadbeef");
      },
    };
    await expect(providerLogin("unique", {}, state.deps)).rejects.toThrow(
      "Unable to allocate a unique provider ID for person-deadbeef.",
    );
  });

  test("uses interactive selection when omitted or ambiguous", async () => {
    const state = fixture();
    state.deps = { ...state.deps, isTTY: true, selectCapability: async () => "@b/two#default" };
    await providerLogin(undefined, {}, state.deps);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@b/two", capability: "default" } });
  });

  test("--provider infers the structured canonical capability and explicit mismatch fails", async () => {
    const provider = { kind: "oauth", plugin: "@a/one", capability: "unique", enabled: true };
    const state = fixture(provider);
    await providerLogin(undefined, { provider: "target" }, state.deps);
    expect(state.calls[1]).toMatchObject({
      targetProviderId: "target",
      capability: { plugin: "@a/one", capability: "unique" },
    });
    await expect(providerLogin("@b/two#default", { provider: "target" }, state.deps)).rejects.toBeInstanceOf(
      ProviderCapabilityMismatchError,
    );
  });

  test("missing target is cleanup-pending and unavailable canonical reference is typed", async () => {
    const state = fixture();
    await expect(providerLogin(undefined, { provider: "target" }, state.deps)).rejects.toMatchObject({
      name: "AccountCleanupPendingError",
    });
    await expect(providerLogin("@missing/pkg#default", {}, state.deps)).rejects.toBeInstanceOf(
      ProviderCapabilityNotFoundError,
    );
    const unavailable = fixture({ kind: "oauth", plugin: "@missing/pkg", capability: "default", enabled: true });
    await expect(providerLogin(undefined, { provider: "target" }, unavailable.deps)).rejects.toBeInstanceOf(
      ProviderCapabilityNotFoundError,
    );
  });

  test("duplicate account prints only the canonical re-login command and rethrows", async () => {
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new ProviderAccountAlreadyExistsError("existing");
      },
    };
    await expect(providerLogin("unique", {}, state.deps)).rejects.toThrow(
      "An account is already configured as provider existing. Run aio-proxy provider login --provider existing to re-login.",
    );
    expect(state.printed).toEqual(["aio-proxy provider login --provider existing"]);
  });

  test("default dependency creation closes SQLite when registry loading fails", async () => {
    let closes = 0;
    await expect(
      createProviderLoginDefaultDeps({
        config: { read: async () => ({ plugins: [], providers: {} }) } as AtomicConfigFile,
        openDatabase: () =>
          ({
            sqlite: {},
            close() {
              closes += 1;
            },
          }) as never,
        createRepository: () => ({ readPluginSecret: () => null }) as never,
        loadRegistry: async () => {
          throw new Error("setup failed");
        },
      }),
    ).rejects.toThrow("setup failed");
    expect(closes).toBe(1);
  });
});
