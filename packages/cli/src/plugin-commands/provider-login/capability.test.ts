import { setLocale } from "@aio-proxy/i18n";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createCapabilitySelector,
  createManualOnlyConfirmation,
  ProviderCapabilityAmbiguousError,
  providerLogin,
} from "./index";
import { createProviderLoginTestScope, registry } from "./test-support";

const scope = createProviderLoginTestScope();
afterEach(scope.cleanup);

describe("provider login capability resolution", () => {
  const builtIns = [
    "@aio-proxy/plugin-github-copilot",
    "@aio-proxy/plugin-openai-chatgpt",
    "@aio-proxy/plugin-google-antigravity",
    "@aio-proxy/plugin-kimi-code",
  ] as const;

  test("uses localized capability prompt copy", async () => {
    let message: string | undefined;
    const selectCapability = createCapabilitySelector(async (config) => {
      message = config.message;
      return config.choices[0]?.value ?? "";
    });
    await expect(selectCapability([{ reference: "@a/one#default", label: "First account" }])).resolves.toBe(
      "@a/one#default",
    );
    expect(message).toBe("Select an OAuth capability.");
  });

  test("uses adapter labels for TTY choice names and canonical references for values", async () => {
    await setLocale("zh-Hans");
    let choices: readonly { readonly name: string; readonly value: string }[] = [];
    const selectCapability = createCapabilitySelector(async (config) => {
      choices = config.choices;
      return config.choices[0]?.value ?? "";
    });
    await expect(
      selectCapability([
        { reference: "@a/one#default", label: { default: "First account", "zh-Hans": "第一个账户" } },
      ] as never),
    ).resolves.toBe("@a/one#default");
    expect(choices).toEqual([{ name: "第一个账户", value: "@a/one#default" }]);
  });

  test("manual-only confirmation uses the login signal", async () => {
    const controller = new AbortController();
    let observedConfig: { readonly message: string; readonly default?: boolean } | undefined;
    let observedSignal: AbortSignal | undefined;
    const confirmManualOnly = createManualOnlyConfirmation(controller.signal, async (config, context) => {
      observedConfig = config;
      observedSignal = context?.signal;
      return true;
    });
    await expect(confirmManualOnly("http://127.0.0.1/callback")).resolves.toBe(true);
    expect(observedSignal).toBe(controller.signal);
    expect(observedConfig).toEqual({ message: "http://127.0.0.1/callback", default: false });
  });

  test("resolves localized progress copy before printing", async () => {
    await setLocale("zh-Hans");
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async (options) => {
        options.progress?.({ default: "Waiting", "zh-Hans": "等待中" });
        return { providerId: "created" };
      },
    };
    await providerLogin("unique", {}, state.deps);
    expect(state.printed).toEqual(["等待中", "created"]);
  });

  test("contains malformed, accessor-backed, and throwing runtime progress copy", async () => {
    await setLocale("zh-Hans");
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
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      login: async (options) => {
        for (const value of [{ "zh-Hans": "missing default" }, accessor, throwing]) options.progress?.(value as never);
        return { providerId: "created" };
      },
    };
    await expect(providerLogin("unique", {}, state.deps)).resolves.toBeUndefined();
    expect(state.printed).toEqual(["created"]);
    expect(reads).toBe(0);
  });

  test("resolves an unambiguous short capability ID", async () => {
    const state = scope.fixture();
    await providerLogin("unique", {}, state.deps);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@a/one", capability: "unique" } });
  });

  test.each(builtIns)("resolves exact built-in package %s to its default capability", async (plugin) => {
    const state = scope.fixture();
    state.deps = {
      ...state.deps,
      registry: registry(builtIns.map((packageName) => [packageName, ["default"]] as const)),
    };

    await providerLogin(plugin, {}, state.deps);

    expect(state.calls[1]).toMatchObject({ capability: { plugin, capability: "default" } });
  });

  test("uses the sole non-default capability for an exact package", async () => {
    const state = scope.fixture();
    state.deps = { ...state.deps, registry: registry([["@single/plugin", ["unique"]]]) };

    await providerLogin("@single/plugin", {}, state.deps);

    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@single/plugin", capability: "unique" } });
  });

  test("prefers the default capability for an exact package", async () => {
    const state = scope.fixture();

    await providerLogin("@a/one", {}, state.deps);

    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@a/one", capability: "default" } });
  });

  test("keeps an exact package with multiple non-default capabilities explicit", async () => {
    const state = scope.fixture();
    state.deps = { ...state.deps, registry: registry([["@multi/plugin", ["alpha", "beta"]]]) };

    await expect(providerLogin("@multi/plugin", {}, state.deps)).rejects.toMatchObject({
      message: "OAuth capability @multi/plugin is ambiguous. Choose one of: @multi/plugin#alpha, @multi/plugin#beta.",
    });
  });

  test("limits interactive package selection to that package", async () => {
    const state = scope.fixture();
    let references: readonly string[] = [];
    state.deps = {
      ...state.deps,
      registry: registry([
        ["@multi/plugin", ["alpha", "beta"]],
        ["@other/plugin", ["alpha"]],
      ]),
      isTTY: true,
      selectCapability: async (choices) => {
        references = choices.map(({ reference }) => reference);
        return "@multi/plugin#beta";
      },
    };

    await providerLogin("@multi/plugin", {}, state.deps);

    expect(references).toEqual(["@multi/plugin#alpha", "@multi/plugin#beta"]);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@multi/plugin", capability: "beta" } });
  });

  test("rejects an unknown exact package", async () => {
    const state = scope.fixture();

    await expect(providerLogin("@missing/plugin", {}, state.deps)).rejects.toMatchObject({
      message: "OAuth capability @missing/plugin was not found.",
    });
  });

  test("lists canonical ambiguity choices in non-interactive mode", async () => {
    const state = scope.fixture();
    await expect(providerLogin("default", {}, state.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "OAuth capability default is ambiguous. Choose one of: @a/one#default, @b/two#default.",
    });
    expect(new ProviderCapabilityAmbiguousError("default", ["@a/one#default"]).references).toEqual(["@a/one#default"]);
  });

  test("uses interactive selection when omitted or ambiguous", async () => {
    const state = scope.fixture();
    state.deps = { ...state.deps, isTTY: true, selectCapability: async () => "@b/two#default" };
    await providerLogin(undefined, {}, state.deps);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@b/two", capability: "default" } });
  });
});
