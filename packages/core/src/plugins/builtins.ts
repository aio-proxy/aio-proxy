import { CLAUDE_CODE_PLUGIN_VERSION, createClaudeCodePlugin } from '@aio-proxy/plugin-claude-code';
import { createCursorPlugin, CURSOR_PLUGIN_VERSION } from '@aio-proxy/plugin-cursor';
import { createGitHubCopilotPlugin, GITHUB_COPILOT_PLUGIN_VERSION } from '@aio-proxy/plugin-github-copilot';
import { createGoogleAntigravityPlugin, GOOGLE_ANTIGRAVITY_PLUGIN_VERSION } from '@aio-proxy/plugin-google-antigravity';
import { createKimiCodePlugin, KIMI_CODE_PLUGIN_VERSION } from '@aio-proxy/plugin-kimi-code';
import { createMuseCodePlugin, MUSE_CODE_PLUGIN_VERSION } from '@aio-proxy/plugin-muse-code';
import { createOpenAIChatGPTPlugin, OPENAI_CHATGPT_PLUGIN_VERSION } from '@aio-proxy/plugin-openai-chatgpt';
import { createOpenCodeGoPlugin, OPENCODE_GO_PLUGIN_VERSION } from '@aio-proxy/plugin-opencode-go';
import { createOpenRouterPlugin, OPENROUTER_PLUGIN_VERSION } from '@aio-proxy/plugin-openrouter';
import type { PluginDescriptor } from '@aio-proxy/plugin-sdk';
import { createXAIGrokPlugin, XAI_GROK_PLUGIN_VERSION } from '@aio-proxy/plugin-xai-grok';

import type { BuiltInPluginDefinition } from './loader/index';

export const BUILT_IN_PLUGIN_PACKAGE_NAMES = [
  '@aio-proxy/plugin-claude-code',
  '@aio-proxy/plugin-cursor',
  '@aio-proxy/plugin-github-copilot',
  '@aio-proxy/plugin-google-antigravity',
  '@aio-proxy/plugin-kimi-code',
  '@aio-proxy/plugin-muse-code',
  '@aio-proxy/plugin-openai-chatgpt',
  '@aio-proxy/plugin-opencode-go',
  '@aio-proxy/plugin-openrouter',
  '@aio-proxy/plugin-xai-grok',
] as const;

const localized = (english: string, chinese: string) => ({ default: english, 'zh-Hans': chinese }) as const;

const chatgptUserAgentPolicyDescription = localized(
  'By default, all requests use the User-Agent configured above. Choose to keep Codex clients’ User-Agent to forward it unchanged; other clients still use the configured value.',
  '默认对所有请求使用上方配置的 User-Agent。选择保留 Codex 客户端的 User-Agent 时，会原样转发它；其他客户端仍使用上方配置的值。',
);

const chatgptGuardianText = {
  guardianStrategyLabel: localized('Guardian review strategy', 'Guardian 审批策略'),
  guardianStrategyDescription: localized(
    'Choose how Codex Guardian approval requests are reviewed.',
    '选择如何审核 Codex Guardian 审批请求。',
  ),
  defaultGuardianLabel: localized('Default', '默认'),
  defaultGuardianDescription: localized(
    'Use the original ChatGPT Guardian review.',
    '使用原有的 ChatGPT Guardian 审核。',
  ),
  systemOneGuardianLabel: localized('System One', 'System One'),
  systemOneGuardianDescription: localized(
    'The selected model’s allow or deny decision is final.',
    '所选模型的允许或拒绝决定即为最终结果。',
  ),
  systemOneReviewDeniedGuardianLabel: localized('System One + original-model review', 'System One + 原模型复核'),
  systemOneReviewDeniedGuardianDescription: localized(
    'The selected model may allow directly; its denials go to the original model for final review.',
    '所选模型可以直接允许；拒绝结果交由原模型进行最终复核。',
  ),
  guardianProviderLabel: localized('Evaluation Provider', '评估 Provider'),
  guardianProviderDescription: localized(
    'Guardian approval context, including the proposed action and conversation evidence, is sent to the selected Provider.',
    'Guardian 审批上下文（包括拟执行的操作和对话证据）会发送给所选 Provider。',
  ),
  guardianModelLabel: localized('Model ID', '模型 ID'),
  guardianModelDescription: localized(
    'Routable model ID on the selected Provider.',
    '所选 Provider 上可路由的模型 ID。',
  ),
};

export function createEmbeddedBuiltIns(): readonly BuiltInPluginDefinition[] {
  return [
    {
      packageName: '@aio-proxy/plugin-claude-code',
      version: CLAUDE_CODE_PLUGIN_VERSION,
      descriptor: createClaudeCodePlugin({
        pluginLabel: localized('Claude Pro/Max', 'Claude Pro/Max'),
        pluginDescription: localized(
          'Use a Claude Pro or Max account to access models',
          '使用 Claude Pro 或 Max 账号访问模型',
        ),
        adapterLabel: localized('Login with Claude', '使用 Claude 登录'),
        waitingForAuthorization: localized('Waiting for Claude authorization', '正在等待 Claude 授权'),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-cursor',
      version: CURSOR_PLUGIN_VERSION,
      descriptor: createCursorPlugin({
        pluginLabel: localized('Cursor', 'Cursor'),
        pluginDescription: localized('Use a Cursor account to access models', '使用 Cursor 账号访问模型'),
        adapterLabel: localized('Login with Cursor', '使用 Cursor 登录'),
        waitingForAuthorization: localized('Waiting for Cursor authorization', '正在等待 Cursor 授权'),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-github-copilot',
      version: GITHUB_COPILOT_PLUGIN_VERSION,
      descriptor: createGitHubCopilotPlugin({
        pluginLabel: localized('GitHub Copilot', 'GitHub Copilot'),
        pluginDescription: localized(
          'Use a GitHub Copilot account to access models',
          '使用 GitHub Copilot 账号访问模型',
        ),
        adapterLabel: localized('Login with GitHub Copilot', '使用 GitHub Copilot 登录'),
        deploymentTypeLabel: localized('Select GitHub deployment type', '选择 GitHub 部署类型'),
        githubDotComLabel: localized('GitHub.com', 'GitHub.com'),
        enterpriseLabel: localized('GitHub Enterprise', 'GitHub Enterprise'),
        enterpriseURLLabel: localized(
          'Enter your GitHub Enterprise URL or domain',
          '输入 GitHub Enterprise URL 或域名',
        ),
        enterpriseURLPlaceholder: localized(
          'company.ghe.com or https://company.ghe.com',
          'company.ghe.com 或 https://company.ghe.com',
        ),
        deviceInstructions: localized('Enter code', '输入代码'),
        refreshingToken: localized('Refreshing GitHub Copilot token', '正在刷新 GitHub Copilot 令牌'),
        waitingForAuthorization: localized('Waiting for GitHub authorization', '正在等待 GitHub 授权'),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-google-antigravity',
      version: GOOGLE_ANTIGRAVITY_PLUGIN_VERSION,
      descriptor: createGoogleAntigravityPlugin({
        pluginLabel: localized('Google Antigravity', 'Google Antigravity'),
        pluginDescription: localized(
          'Use a Google Antigravity account to access Cloud Code Assist models',
          '使用 Google Antigravity 账号访问 Cloud Code Assist 模型',
        ),
        adapterLabel: localized('Login with Google Antigravity', '使用 Google Antigravity 登录'),
        baseURLLabel: localized('Custom Antigravity base URL', '自定义 Antigravity Base URL'),
        baseURLPlaceholder: 'https://daily-cloudcode-pa.googleapis.com',
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-kimi-code',
      version: KIMI_CODE_PLUGIN_VERSION,
      descriptor: createKimiCodePlugin({
        pluginLabel: localized('Kimi Code', 'Kimi Code'),
        pluginDescription: localized('Use a Kimi Code account to access models', '使用 Kimi Code 账号访问模型'),
        adapterLabel: localized('Login with Kimi Code', '使用 Kimi Code 登录'),
        deviceInstructions: localized('Enter code', '输入代码'),
        waitingForAuthorization: localized('Waiting for Kimi authorization', '正在等待 Kimi 授权'),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-muse-code',
      version: MUSE_CODE_PLUGIN_VERSION,
      descriptor: createMuseCodePlugin({
        pluginLabel: localized('Muse Code', 'Muse Code'),
        pluginDescription: localized(
          'Use a Muse Code subscription to access Meta models',
          '使用 Muse Code 订阅访问 Meta 模型',
        ),
        adapterLabel: localized('Login with Muse Code', '使用 Muse Code 登录'),
        deviceInstructions: localized('Enter code', '输入代码'),
        waitingForAuthorization: localized('Waiting for Muse authorization', '正在等待 Muse 授权'),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-openai-chatgpt',
      version: OPENAI_CHATGPT_PLUGIN_VERSION,
      descriptor: createOpenAIChatGPTPlugin({
        pluginLabel: localized('OpenAI ChatGPT', 'OpenAI ChatGPT'),
        pluginDescription: localized(
          'Use a ChatGPT Plus or Pro account to access models',
          '使用 ChatGPT Plus 或 Pro 账号访问模型',
        ),
        adapterLabel: localized('Login with ChatGPT (Plus/Pro)', '使用 ChatGPT（Plus/Pro）登录'),
        userAgentLabel: localized('User-Agent', 'User-Agent'),
        userAgentDescription: localized(
          'Leave blank to use the default. {{latest_codex_rs_version}} is replaced with the latest Codex release, which is also sent as the catalog client version.',
          '留空则使用默认值。{{latest_codex_rs_version}} 会替换为最新的 Codex 版本，并同时作为模型目录的 client version。',
        ),
        userAgentPolicyLabel: localized('User-Agent policy', 'User-Agent 策略'),
        userAgentPolicyDescription: chatgptUserAgentPolicyDescription,
        fixedPolicyLabel: localized('Always use the configured User-Agent', '始终使用配置的 User-Agent'),
        preserveCodexClientLabel: localized('Keep the User-Agent from Codex clients', '保留 Codex 客户端的 User-Agent'),
        ...chatgptGuardianText,
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-opencode-go',
      version: OPENCODE_GO_PLUGIN_VERSION,
      descriptor: createOpenCodeGoPlugin({
        pluginLabel: localized('OpenCode Go', 'OpenCode Go'),
        pluginDescription: localized(
          'Use an OpenCode Go subscription to access open coding models',
          '使用 OpenCode Go 订阅访问开源编码模型',
        ),
        adapterLabel: localized('Login with OpenCode Go', '使用 OpenCode Go 登录'),
        apiKeyLabel: localized('OpenCode API key', 'OpenCode API key'),
        apiKeyDescription: localized(
          'Create or copy a key at https://opencode.ai/auth. Go needs its own paid subscription.',
          '在 https://opencode.ai/auth 创建或复制 API key。Go 需要单独的付费订阅。',
        ),
        waitingForAuthorization: localized('Waiting for OpenCode authorization', '正在等待 OpenCode 授权'),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-openrouter',
      version: OPENROUTER_PLUGIN_VERSION,
      descriptor: createOpenRouterPlugin({
        pluginLabel: 'OpenRouter',
        pluginDescription: localized(
          'Sign in with OpenRouter to mint an API key',
          '使用 OpenRouter 登录并签发 API key',
        ),
        adapterLabel: localized('Login with OpenRouter', '使用 OpenRouter 登录'),
        waitingForAuthorization: localized('Waiting for OpenRouter authorization', '正在等待 OpenRouter 授权'),
      }) as unknown as PluginDescriptor<unknown>,
    },
    {
      packageName: '@aio-proxy/plugin-xai-grok',
      version: XAI_GROK_PLUGIN_VERSION,
      descriptor: createXAIGrokPlugin({
        pluginLabel: 'xAI Grok',
        pluginDescription: localized(
          'Use a SuperGrok or X Premium+ account to access Grok models',
          '使用 SuperGrok 或 X Premium+ 账号访问 Grok 模型',
        ),
        adapterLabel: localized('Login with xAI Grok', '使用 xAI Grok 登录'),
        deviceInstructions: localized('Enter code', '输入代码'),
        waitingForAuthorization: localized('Waiting for xAI authorization', '正在等待 xAI 授权'),
      }) as unknown as PluginDescriptor<unknown>,
    },
  ];
}
