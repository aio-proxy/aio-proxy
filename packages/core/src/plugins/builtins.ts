import { createGitHubCopilotPlugin, GITHUB_COPILOT_PLUGIN_VERSION } from "@aio-proxy/plugin-github-copilot";
import { createGoogleAntigravityPlugin, GOOGLE_ANTIGRAVITY_PLUGIN_VERSION } from "@aio-proxy/plugin-google-antigravity";
import { createOpenAIChatGPTPlugin, OPENAI_CHATGPT_PLUGIN_VERSION } from "@aio-proxy/plugin-openai-chatgpt";
import type { PluginDescriptor } from "@aio-proxy/plugin-sdk";
import type { BuiltInPluginDefinition } from "./loader/index";

export const BUILT_IN_PLUGIN_PACKAGE_NAMES = [
  "@aio-proxy/plugin-github-copilot",
  "@aio-proxy/plugin-openai-chatgpt",
  "@aio-proxy/plugin-google-antigravity",
] as const;

const localized = (english: string, chinese: string) => ({ default: english, "zh-Hans": chinese }) as const;

export function createEmbeddedBuiltIns(): readonly BuiltInPluginDefinition[] {
  return [
    {
      packageName: "@aio-proxy/plugin-github-copilot",
      version: GITHUB_COPILOT_PLUGIN_VERSION,
      descriptor: createGitHubCopilotPlugin({
        pluginLabel: localized("GitHub Copilot", "GitHub Copilot"),
        pluginDescription: localized(
          "Use a GitHub Copilot account to access models",
          "使用 GitHub Copilot 账号访问模型",
        ),
        adapterLabel: localized("Login with GitHub Copilot", "使用 GitHub Copilot 登录"),
        deploymentTypeLabel: localized("Select GitHub deployment type", "选择 GitHub 部署类型"),
        githubDotComLabel: localized("GitHub.com", "GitHub.com"),
        enterpriseLabel: localized("GitHub Enterprise", "GitHub Enterprise"),
        enterpriseURLLabel: localized(
          "Enter your GitHub Enterprise URL or domain",
          "输入 GitHub Enterprise URL 或域名",
        ),
        enterpriseURLPlaceholder: localized(
          "company.ghe.com or https://company.ghe.com",
          "company.ghe.com 或 https://company.ghe.com",
        ),
        deviceInstructions: localized("Enter code", "输入代码"),
        refreshingToken: localized("Refreshing GitHub Copilot token", "正在刷新 GitHub Copilot 令牌"),
        waitingForAuthorization: localized("Waiting for GitHub authorization", "正在等待 GitHub 授权"),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: "@aio-proxy/plugin-openai-chatgpt",
      version: OPENAI_CHATGPT_PLUGIN_VERSION,
      descriptor: createOpenAIChatGPTPlugin({
        pluginLabel: localized("OpenAI ChatGPT", "OpenAI ChatGPT"),
        pluginDescription: localized(
          "Use a ChatGPT Plus or Pro account to access models",
          "使用 ChatGPT Plus 或 Pro 账号访问模型",
        ),
        adapterLabel: localized("Login with ChatGPT (Plus/Pro)", "使用 ChatGPT（Plus/Pro）登录"),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: "@aio-proxy/plugin-google-antigravity",
      version: GOOGLE_ANTIGRAVITY_PLUGIN_VERSION,
      descriptor: createGoogleAntigravityPlugin({
        pluginLabel: localized("Google Antigravity", "Google Antigravity"),
        pluginDescription: localized(
          "Use a Google Antigravity account to access Cloud Code Assist models",
          "使用 Google Antigravity 账号访问 Cloud Code Assist 模型",
        ),
        adapterLabel: localized("Login with Google Antigravity", "使用 Google Antigravity 登录"),
        baseURLLabel: localized("Custom Antigravity base URL", "自定义 Antigravity Base URL"),
        baseURLPlaceholder: "https://daily-cloudcode-pa.googleapis.com",
      }) as unknown as PluginDescriptor<unknown>,
    },
  ];
}
