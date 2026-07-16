import { afterEach, expect, test } from "bun:test";
import { getLocale, setLocale } from "@aio-proxy/i18n";
import { resolveLocalizedText } from "@aio-proxy/plugin-sdk";
import { createEmbeddedBuiltIns } from "../../src/plugins/builtins";
import { loadPluginRegistry } from "../../src/plugins/loader";

const diagnostics = (code: string) => ({
  code,
  summary: code,
  retryable: false,
  occurredAt: new Date(0).toISOString(),
});

const originalLocale = getLocale();
afterEach(async () => {
  await setLocale(originalLocale);
});

test("reserved identities always load embedded descriptors without package lookup", async () => {
  const imported: string[] = [];
  const snapshot = await loadPluginRegistry({
    enablements: ["@aio-proxy/plugin-github-copilot", "@aio-proxy/plugin-openai-chatgpt"].map((packageName) => ({
      packageName,
    })),
    builtIns: createEmbeddedBuiltIns(),
    diagnostics: diagnostics as never,
    importPackage: async ({ packageName }) => {
      imported.push(packageName);
      throw new Error("cache must not be consulted");
    },
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
  });

  expect(imported).toEqual([]);
  expect([...snapshot.plugins.values()].map(({ builtIn }) => builtIn)).toEqual([true, true]);
  expect([...snapshot.plugins.values()].map(({ version }) => version)).toEqual(["0.0.0", "0.0.0"]);
});

test("embedded adapters retain English and Chinese copy independent of creation locale", async () => {
  await setLocale("zh-Hans");
  const snapshot = await loadPluginRegistry({
    enablements: [],
    builtIns: createEmbeddedBuiltIns(),
    diagnostics: diagnostics as never,
    importPackage: async () => {
      throw new Error("unexpected import");
    },
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
  });

  const adapter = snapshot.registry.resolveOAuth("@aio-proxy/plugin-github-copilot", "default");
  const plugin = snapshot.plugins.get("@aio-proxy/plugin-github-copilot");
  expect(resolveLocalizedText(plugin?.label ?? "", "en")).toBe("GitHub Copilot");
  expect(resolveLocalizedText(plugin?.label ?? "", "zh-Hans")).toBe("GitHub Copilot");
  expect(resolveLocalizedText(plugin?.description ?? "", "zh-Hans")).toBe("使用 GitHub Copilot 账号访问模型");
  expect(resolveLocalizedText(adapter?.label ?? "", "en")).toBe("Login with GitHub Copilot");
  expect(resolveLocalizedText(adapter?.label ?? "", "zh-Hans")).toBe("使用 GitHub Copilot 登录");
  expect(resolveLocalizedText(adapter?.account.options.form[0]?.label ?? "", "zh-Hans")).toBe("选择 GitHub 部署类型");
});
