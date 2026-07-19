import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicConfigFile, createPluginRegistryHost } from "@aio-proxy/core";
import { getLocale, setLocale } from "@aio-proxy/i18n";
import { type OAuthAdapter, zod } from "@aio-proxy/plugin-sdk";
import type { ProviderLoginDeps } from "./index";

export function adapter(id: string): OAuthAdapter {
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

type RegistryEntry = readonly [plugin: string, capabilities: readonly string[]];

const defaultRegistryEntries: readonly RegistryEntry[] = [
  ["@a/one", ["default", "unique"]],
  ["@b/two", ["default"]],
];

export function registry(entries: readonly RegistryEntry[] = defaultRegistryEntries) {
  const host = createPluginRegistryHost();
  for (const [plugin, ids] of entries) {
    const staging = host.stage(plugin);
    for (const id of ids) staging.api.oauth.register(adapter(id));
    staging.seal();
    staging.commit();
  }
  return host.registry;
}

export function createProviderLoginTestScope() {
  const roots: string[] = [];
  const originalLocale = getLocale();
  const fixture = (provider?: Record<string, unknown>) => {
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
      selectCapability: async (choices) => choices[0]?.reference ?? "",
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
  };
  const cleanup = async () => {
    await setLocale(originalLocale);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  };
  return { cleanup, fixture };
}
