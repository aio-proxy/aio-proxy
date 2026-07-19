import { afterEach, expect, test } from "bun:test";
import { getLocale, setLocale } from "@aio-proxy/i18n";
import { resolveLocalizedText } from "@aio-proxy/plugin-sdk";
import { BUILT_IN_PLUGIN_PACKAGE_NAMES, createEmbeddedBuiltIns } from "./builtins";
import { loadPluginRegistry } from "./loader/index";

const expectedBuiltIns = [
  "@aio-proxy/plugin-github-copilot",
  "@aio-proxy/plugin-openai-chatgpt",
  "@aio-proxy/plugin-google-antigravity",
  "@aio-proxy/plugin-kimi-code",
] as const;

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
    enablements: expectedBuiltIns.map((packageName) => ({ packageName })),
    builtIns: createEmbeddedBuiltIns(),
    diagnostics: diagnostics as never,
    importPackage: async ({ packageName }) => {
      imported.push(packageName);
      throw new Error("cache must not be consulted");
    },
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
  });

  expect(BUILT_IN_PLUGIN_PACKAGE_NAMES).toEqual(expectedBuiltIns);
  expect(imported).toEqual([]);
  expect([...snapshot.plugins.values()].map(({ builtIn }) => builtIn)).toEqual([true, true, true, true]);
  expect([...snapshot.plugins.values()].map(({ version }) => version)).toEqual(["0.0.0", "0.0.0", "0.0.0", "0.0.0"]);
  expect(snapshot.registry.resolveOAuth("@aio-proxy/plugin-google-antigravity", "default")).toBeDefined();
  expect(snapshot.registry.resolveOAuth("@aio-proxy/plugin-kimi-code", "default")).toBeDefined();
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

  const antigravity = snapshot.registry.resolveOAuth("@aio-proxy/plugin-google-antigravity", "default");
  const antigravityPlugin = snapshot.plugins.get("@aio-proxy/plugin-google-antigravity");
  expect(resolveLocalizedText(antigravityPlugin?.label ?? "", "zh-Hans")).toBe("Google Antigravity");
  expect(resolveLocalizedText(antigravityPlugin?.description ?? "", "zh-Hans")).toBe(
    "使用 Google Antigravity 账号访问 Cloud Code Assist 模型",
  );
  expect(resolveLocalizedText(antigravity?.label ?? "", "zh-Hans")).toBe("使用 Google Antigravity 登录");
  expect(resolveLocalizedText(antigravity?.account.options.form[0]?.label ?? "", "zh-Hans")).toBe(
    "自定义 Antigravity Base URL",
  );
  expect(resolveLocalizedText(antigravity?.account.options.form[0]?.placeholder ?? "", "en")).toBe(
    "https://daily-cloudcode-pa.googleapis.com",
  );

  const kimi = snapshot.registry.resolveOAuth("@aio-proxy/plugin-kimi-code", "default");
  const kimiPlugin = snapshot.plugins.get("@aio-proxy/plugin-kimi-code");
  expect(resolveLocalizedText(kimiPlugin?.label ?? "", "zh-Hans")).toBe("Kimi Code");
  expect(resolveLocalizedText(kimiPlugin?.description ?? "", "zh-Hans")).toBe("使用 Kimi Code 账号访问模型");
  expect(resolveLocalizedText(kimi?.label ?? "", "zh-Hans")).toBe("使用 Kimi Code 登录");
});
