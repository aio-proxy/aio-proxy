import { type ConfigSpec, type LocalizedText, zod } from '@aio-proxy/plugin-sdk';

import { CHATGPT_USER_AGENT } from '../codex-client';

export type ChatGPTUserAgentPolicy = 'fixed' | 'preserveCodexClient';

export type ChatGPTAccountOptions = {
  readonly userAgent: string;
  readonly userAgentPolicy: ChatGPTUserAgentPolicy;
};

export type ChatGPTAccountOptionsText = {
  readonly userAgentLabel: LocalizedText;
  readonly userAgentPolicyLabel: LocalizedText;
  readonly fixedPolicyLabel: LocalizedText;
  readonly preserveCodexClientLabel: LocalizedText;
};

const CODEX_CLIENT_MARKERS = ['codex-tui', 'codex_cli_rs', 'codex desktop'] as const;

export const englishAccountOptionsText: ChatGPTAccountOptionsText = {
  userAgentLabel: 'User agent',
  userAgentPolicyLabel: 'User agent policy',
  fixedPolicyLabel: 'Always use the configured user agent',
  preserveCodexClientLabel: 'Keep the user agent from Codex clients',
};

export function chatGPTAccountOptions(text: ChatGPTAccountOptionsText): ConfigSpec<Partial<ChatGPTAccountOptions>> {
  return {
    schema: zod
      .object({
        userAgent: zod
          .string()
          .trim()
          .optional()
          .transform((value) => (value === undefined || value === '' ? CHATGPT_USER_AGENT : value)),
        userAgentPolicy: zod.enum(['fixed', 'preserveCodexClient']).default('fixed'),
      })
      .transform((value): ChatGPTAccountOptions => value),
    form: [
      {
        type: 'text',
        key: 'userAgent',
        label: text.userAgentLabel,
        placeholder: CHATGPT_USER_AGENT,
      },
      {
        type: 'select',
        key: 'userAgentPolicy',
        label: text.userAgentPolicyLabel,
        options: [
          { value: 'fixed', label: text.fixedPolicyLabel },
          { value: 'preserveCodexClient', label: text.preserveCodexClientLabel },
        ],
      },
    ],
  };
}

export function resolveChatGPTUserAgent(
  options: Partial<ChatGPTAccountOptions> | undefined,
  inbound: string | null,
): string {
  const configured = options?.userAgent?.trim();
  const userAgent = configured === undefined || configured === '' ? CHATGPT_USER_AGENT : configured;
  if (options?.userAgentPolicy !== 'preserveCodexClient' || inbound === null) return userAgent;
  const normalized = inbound.toLowerCase();
  return CODEX_CLIENT_MARKERS.some((marker) => normalized.includes(marker)) ? inbound : userAgent;
}
