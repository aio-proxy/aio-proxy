import { AtomicConfigFile, type PluginSecretSnapshot } from "@aio-proxy/core";
import { definePlugin } from "@aio-proxy/plugin-sdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type PluginLifecycleDeps, pluginConfig } from "./index";

export function descriptorWithForm(
  form: readonly Record<string, unknown>[],
  transform: (value: unknown) => unknown = (value) => value,
) {
  return definePlugin(() => {}, {
    options: {
      schema: {
        safeParse() {},
        async safeParseAsync(value: unknown) {
          return { success: true, data: transform(value) };
        },
      } as never,
      form: form as never,
    },
  });
}

export function createPluginTestScope() {
  const homes: string[] = [];
  const harness = (initial: Record<string, unknown> = { providers: {}, plugins: [] }) => {
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-command-"));
    homes.push(home);
    const path = join(home, "config.jsonc");
    writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`);
    const config = new AtomicConfigFile(path);
    const values = new Map<string, PluginSecretSnapshot>();
    const lines: string[] = [];
    const deps: PluginLifecycleDeps = {
      config,
      builtInNames: new Set(["@aio-proxy/plugin-github-copilot"]),
      confirm: async () => true,
      importPackage: async () => ({ default: definePlugin(() => {}) }),
      isTTY: true,
      findInstalledNpmPackage: async () => ({ version: "1.0.0", entrypoint: "/tmp/plugin.js" }),
      listInstalledNpmPackages: async () => [],
      npmAdd: async () => ({ version: "1.0.0", entrypoint: "/tmp/plugin.js" }),
      print: (line) => lines.push(line),
      prompts: {
        input: async () => "",
        password: async () => "",
        confirm: async () => true,
        select: async () => "",
      },
      removeNpmPackageCache: async () => false,
      repository: {
        readPluginSecret(plugin) {
          return values.get(plugin) ?? null;
        },
        writePluginSecret(plugin, expectedRevision, value) {
          const current = values.get(plugin) ?? null;
          if ((current?.revision ?? null) !== expectedRevision) throw new Error("Plugin secret revision mismatch");
          const snapshot = { value, revision: (current?.revision ?? 0) + 1 };
          values.set(plugin, snapshot);
          return snapshot;
        },
        deletePluginSecret(plugin, expectedRevision) {
          const current = values.get(plugin);
          if (current?.revision !== expectedRevision) return false;
          values.delete(plugin);
          return true;
        },
      },
    };
    return { config, deps, lines, path, values };
  };
  return {
    harness,
    trackHome(home: string) {
      homes.push(home);
    },
    cleanup() {
      for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    },
  };
}

export type PluginTestState = ReturnType<ReturnType<typeof createPluginTestScope>["harness"]>;

export const textDescriptor = () => descriptorWithForm([{ type: "text", key: "endpoint", label: "Endpoint" }]);
export const secretDescriptor = () => descriptorWithForm([{ type: "secret", key: "token", label: "Token" }]);
export const textSecretDescriptor = () =>
  descriptorWithForm([
    { type: "text", key: "endpoint", label: "Endpoint" },
    { type: "secret", key: "token", label: "Token" },
  ]);

export function configFacade(state: PluginTestState, transaction: AtomicConfigFile["transaction"]): AtomicConfigFile {
  return {
    read: state.deps.config.read.bind(state.deps.config),
    transaction,
  } as AtomicConfigFile;
}

export function configureSecret(
  state: PluginTestState,
  config: AtomicConfigFile,
  repository: PluginLifecycleDeps["repository"] = state.deps.repository,
) {
  const descriptor = secretDescriptor();
  return pluginConfig(
    "secret-plugin",
    {},
    {
      ...state.deps,
      config,
      repository,
      importPackage: async () => ({ default: descriptor }),
      prompts: { ...state.deps.prompts, password: async () => "new" },
    },
  );
}
