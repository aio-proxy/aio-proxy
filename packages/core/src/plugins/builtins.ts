import { m } from "@aio-proxy/i18n";
import { createGitHubCopilotPlugin, GITHUB_COPILOT_PLUGIN_VERSION } from "@aio-proxy/plugin-github-copilot";
import { createOpenAIChatGPTPlugin, OPENAI_CHATGPT_PLUGIN_VERSION } from "@aio-proxy/plugin-openai-chatgpt";
import type { PluginDescriptor } from "@aio-proxy/plugin-sdk";
import type { BuiltInPluginDefinition } from "./loader";

export const BUILT_IN_PLUGIN_PACKAGE_NAMES = [
  "@aio-proxy/plugin-github-copilot",
  "@aio-proxy/plugin-openai-chatgpt",
] as const;

export function createEmbeddedBuiltIns(): readonly BuiltInPluginDefinition[] {
  return [
    {
      packageName: "@aio-proxy/plugin-github-copilot",
      version: GITHUB_COPILOT_PLUGIN_VERSION,
      descriptor: createGitHubCopilotPlugin({
        adapterLabel: m["oauth.github-copilot.login_label"](),
        deploymentTypeLabel: m["oauth.github-copilot.deployment_type.message"](),
        githubDotComLabel: m["oauth.github-copilot.deployment_type.options.github.label"](),
        enterpriseLabel: m["oauth.github-copilot.deployment_type.options.github-enterprise.label"](),
        enterpriseURLLabel: m["oauth.github-copilot.enterprise_url.message"](),
        enterpriseURLPlaceholder: m["oauth.github-copilot.enterprise_url.placeholder"](),
        deviceInstructions: m["oauth.github-copilot.device_instructions"](),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: "@aio-proxy/plugin-openai-chatgpt",
      version: OPENAI_CHATGPT_PLUGIN_VERSION,
      descriptor: createOpenAIChatGPTPlugin({
        adapterLabel: m["oauth.openai-chatgpt.login_label"](),
      }) as unknown as PluginDescriptor<unknown>,
    },
  ];
}
