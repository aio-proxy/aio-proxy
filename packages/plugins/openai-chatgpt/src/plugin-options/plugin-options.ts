import { type ConfigSpec, type LocalizedText, type RuntimeFetch, zod } from '@aio-proxy/plugin-sdk';

import { CODEX_CLIENT_VERSION, DEFAULT_CHATGPT_USER_AGENT, LATEST_CODEX_RS_VERSION_TOKEN } from '../codex-client';
import { latestCodexRsVersion } from './codex-version';

export type ChatGPTUserAgentPolicy = 'fixed' | 'preserveCodexClient';

export type ChatGPTPluginOptions = {
  readonly userAgent: string;
  readonly userAgentPolicy: ChatGPTUserAgentPolicy;
};

export type ChatGPTPluginOptionsText = {
  readonly userAgentLabel: LocalizedText;
  readonly userAgentDescription: LocalizedText;
  readonly userAgentPolicyLabel: LocalizedText;
  readonly fixedPolicyLabel: LocalizedText;
  readonly preserveCodexClientLabel: LocalizedText;
};

const CODEX_CLIENT_MARKERS = ['codex-tui', 'codex_cli_rs', 'codex desktop'] as const;
const EXACT_LATEST_TOKEN = /(?<!\{)\{latest_codex_rs_version\}(?!\})/u;

export const englishPluginOptionsText: ChatGPTPluginOptionsText = {
  userAgentLabel: 'User agent',
  userAgentDescription: `Leave blank to use the default. ${LATEST_CODEX_RS_VERSION_TOKEN} is replaced with the latest Codex release, which is also sent as the catalog client version.`,
  userAgentPolicyLabel: 'User agent policy',
  fixedPolicyLabel: 'Always use the configured user agent',
  preserveCodexClientLabel: 'Keep the user agent from Codex clients',
};

function isHttpHeaderValue(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || code > 0xff) return false;
  }
  return true;
}

export function chatGPTPluginOptions(text: ChatGPTPluginOptionsText): ConfigSpec<ChatGPTPluginOptions> {
  return {
    schema: zod
      .object({
        userAgent: zod
          .string()
          .trim()
          .refine((value) => value === '' || isHttpHeaderValue(value), 'User agent is not a valid HTTP header value')
          .optional()
          .transform((value) => (value === undefined || value === '' ? DEFAULT_CHATGPT_USER_AGENT : value)),
        userAgentPolicy: zod.enum(['fixed', 'preserveCodexClient']).default('fixed'),
      })
      .transform((value): ChatGPTPluginOptions => value),
    form: [
      {
        type: 'text',
        key: 'userAgent',
        label: text.userAgentLabel,
        description: text.userAgentDescription,
        placeholder: DEFAULT_CHATGPT_USER_AGENT,
        defaultValue: DEFAULT_CHATGPT_USER_AGENT,
      },
      {
        type: 'select',
        key: 'userAgentPolicy',
        label: text.userAgentPolicyLabel,
        defaultValue: 'fixed',
        options: [
          { value: 'fixed', label: text.fixedPolicyLabel },
          { value: 'preserveCodexClient', label: text.preserveCodexClientLabel },
        ],
      },
    ],
  };
}

function userAgentAsksForLatestCodex(template: string): boolean {
  return EXACT_LATEST_TOKEN.test(template);
}

export async function resolveChatGPTRequestIdentity(
  options: Partial<ChatGPTPluginOptions> | undefined,
  inbound: string | null,
  fetchImpl?: RuntimeFetch,
): Promise<{ readonly userAgent: string; readonly clientVersion: string }> {
  const configured = options?.userAgent?.trim();
  const template = configured === undefined || configured === '' ? DEFAULT_CHATGPT_USER_AGENT : configured;
  const asksForLatest = userAgentAsksForLatestCodex(template);
  const clientVersion = asksForLatest ? await latestCodexRsVersion(fetchImpl) : CODEX_CLIENT_VERSION;
  const userAgent = asksForLatest
    ? template.replace(new RegExp(EXACT_LATEST_TOKEN.source, 'gu'), clientVersion)
    : template;
  if (options?.userAgentPolicy !== 'preserveCodexClient' || inbound === null) return { userAgent, clientVersion };
  const normalized = inbound.toLowerCase();
  return {
    userAgent: CODEX_CLIENT_MARKERS.some((marker) => normalized.includes(marker)) ? inbound : userAgent,
    clientVersion,
  };
}
