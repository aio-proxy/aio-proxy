import {
  definePlugin,
  type OAuthAdapter,
  PLUGIN_DESCRIPTOR_BRAND,
  type PluginDescriptor,
  zod,
} from "@aio-proxy/plugin-sdk";
import { expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type { DiagnosticFactory } from "../diagnostic/index";

import { loadPluginRegistry, PLUGIN_IMPORT_TIMEOUT_MS, PLUGIN_SETUP_TIMEOUT_MS, type PluginPackageImporter } from ".";
import { npmPackageCacheDir } from "../../npm";

const home = mkdtempSync(`${tmpdir()}/aio-proxy-plugin-loader-`);

process.env["AIO_PROXY_HOME"] = home;

const diagnostics: DiagnosticFactory = (code, options) => ({
  code,
  retryable: options.retryable,
  summary: code,
  occurredAt: new Date(0).toISOString(),
  ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
});

function install(packageName: string, version = "1.0.0") {
  const packageRoot = `${npmPackageCacheDir(packageName)}/node_modules/${packageName}`;
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(`${packageRoot}/package.json`, JSON.stringify({ name: packageName, version, main: "index.js" }));
  writeFileSync(`${packageRoot}/index.js`, "export default {};\n");
}

function adapter(id = "default"): OAuthAdapter {
  return {
    id,
    label: "Example",
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

function options(overrides: Record<string, unknown> = {}) {
  return {
    enablements: [] as { packageName: string; options?: unknown }[],
    builtIns: [] as { packageName: string; version: string; descriptor: PluginDescriptor<unknown> }[],
    diagnostics,
    importPackage: async () => ({}),
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
    ...overrides,
  };
}

export type { PluginDescriptor, PluginPackageImporter };
export {
  adapter,
  definePlugin,
  expect,
  install,
  jest,
  loadPluginRegistry,
  options,
  PLUGIN_DESCRIPTOR_BRAND,
  PLUGIN_IMPORT_TIMEOUT_MS,
  PLUGIN_SETUP_TIMEOUT_MS,
  test,
  zod,
};
