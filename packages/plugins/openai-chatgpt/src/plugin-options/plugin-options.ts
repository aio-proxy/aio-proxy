import { type ConfigSpec, type LocalizedText, type RuntimeFetch, renderTemplate, zod } from '@aio-proxy/plugin-sdk';

import { CODEX_CLIENT_VERSION, DEFAULT_CHATGPT_USER_AGENT, LATEST_CODEX_RS_VERSION_TOKEN } from '../codex-client';
import { latestCodexRsVersion } from './codex-version';

export type ChatGPTUserAgentPolicy = 'fixed' | 'preserveCodexClient';

export type ChatGPTPluginOptions = {
  readonly userAgent: string;
  readonly userAgentPolicy: ChatGPTUserAgentPolicy;
  readonly guardianStrategy: 'default' | 'systemOne' | 'systemOneReviewDenied';
  readonly guardianProviderId?: string;
  readonly guardianModelId?: string;
};

export type ChatGPTPluginOptionsText = {
  readonly userAgentLabel: LocalizedText;
  readonly userAgentDescription: LocalizedText;
  readonly userAgentPolicyLabel: LocalizedText;
  readonly userAgentPolicyDescription: LocalizedText;
  readonly fixedPolicyLabel: LocalizedText;
  readonly preserveCodexClientLabel: LocalizedText;
  readonly guardianStrategyLabel: LocalizedText;
  readonly guardianStrategyDescription: LocalizedText;
  readonly defaultGuardianLabel: LocalizedText;
  readonly defaultGuardianDescription: LocalizedText;
  readonly systemOneGuardianLabel: LocalizedText;
  readonly systemOneGuardianDescription: LocalizedText;
  readonly systemOneReviewDeniedGuardianLabel: LocalizedText;
  readonly systemOneReviewDeniedGuardianDescription: LocalizedText;
  readonly guardianProviderLabel: LocalizedText;
  readonly guardianProviderDescription: LocalizedText;
  readonly guardianModelLabel: LocalizedText;
  readonly guardianModelDescription: LocalizedText;
};

const CODEX_CLIENT_MARKERS = ['codex-tui', 'codex_cli_rs', 'codex desktop'] as const;

export const englishPluginOptionsText: ChatGPTPluginOptionsText = {
  userAgentLabel: 'User-Agent',
  userAgentDescription: `Leave blank to use the default. ${LATEST_CODEX_RS_VERSION_TOKEN} is replaced with the latest Codex release, which is also sent as the catalog client version.`,
  userAgentPolicyLabel: 'User-Agent policy',
  userAgentPolicyDescription:
    'By default, all requests use the User-Agent configured above. Choose to keep Codex clients’ User-Agent to forward it unchanged; other clients still use the configured value.',
  fixedPolicyLabel: 'Always use the configured User-Agent',
  preserveCodexClientLabel: 'Keep the User-Agent from Codex clients',
  guardianStrategyLabel: 'Guardian review strategy',
  guardianStrategyDescription: 'Choose how Codex Guardian approval requests are reviewed.',
  defaultGuardianLabel: 'Default',
  defaultGuardianDescription: 'Use the original ChatGPT Guardian review.',
  systemOneGuardianLabel: 'System One',
  systemOneGuardianDescription: 'The selected model’s allow or deny decision is final.',
  systemOneReviewDeniedGuardianLabel: 'System One + original-model review',
  systemOneReviewDeniedGuardianDescription:
    'The selected model may allow directly; its denials go to the original model for final review.',
  guardianProviderLabel: 'Evaluation Provider',
  guardianProviderDescription:
    'Guardian approval context, including the proposed action and conversation evidence, is sent to the selected Provider.',
  guardianModelLabel: 'Model ID',
  guardianModelDescription: 'Routable model ID on the selected Provider.',
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
          .refine((value) => value === '' || isHttpHeaderValue(value), 'User-Agent is not a valid HTTP header value')
          .refine((value) => {
            try {
              codexVersionTemplate(value);
              return true;
            } catch {
              return false;
            }
          }, 'User-Agent contains an unsupported template')
          .optional()
          .transform((value) => (value === undefined || value === '' ? DEFAULT_CHATGPT_USER_AGENT : value)),
        userAgentPolicy: zod.enum(['fixed', 'preserveCodexClient']).default('fixed'),
        guardianStrategy: zod.enum(['default', 'systemOne', 'systemOneReviewDenied']).default('default'),
        guardianProviderId: zod.string().trim().min(1).optional(),
        guardianModelId: zod.string().trim().min(1).optional(),
      })
      .superRefine((value, ctx) => {
        if (value.guardianStrategy === 'default') return;
        for (const key of ['guardianProviderId', 'guardianModelId'] as const) {
          if (value[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required` });
        }
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
        description: text.userAgentPolicyDescription,
        defaultValue: 'fixed',
        options: [
          { value: 'fixed', label: text.fixedPolicyLabel },
          { value: 'preserveCodexClient', label: text.preserveCodexClientLabel },
        ],
      },
      {
        type: 'select',
        key: 'guardianStrategy',
        label: text.guardianStrategyLabel,
        description: text.guardianStrategyDescription,
        defaultValue: 'default',
        options: [
          { value: 'default', label: text.defaultGuardianLabel, description: text.defaultGuardianDescription },
          { value: 'systemOne', label: text.systemOneGuardianLabel, description: text.systemOneGuardianDescription },
          {
            value: 'systemOneReviewDenied',
            label: text.systemOneReviewDeniedGuardianLabel,
            description: text.systemOneReviewDeniedGuardianDescription,
          },
        ],
      },
      {
        type: 'provider',
        key: 'guardianProviderId',
        label: text.guardianProviderLabel,
        description: text.guardianProviderDescription,
        protocols: ['typesafe-systemone'],
        when: { key: 'guardianStrategy', notEquals: 'default' },
      },
      {
        type: 'provider-model',
        key: 'guardianModelId',
        label: text.guardianModelLabel,
        description: text.guardianModelDescription,
        providerKey: 'guardianProviderId',
        when: { key: 'guardianStrategy', notEquals: 'default' },
      },
    ],
  };
}

function codexVersionTemplate(template: string): string {
  return renderTemplate(template, (name) => {
    if (name !== 'latest_codex_rs_version') throw new TypeError('Unsupported User-Agent template');
    return LATEST_CODEX_RS_VERSION_TOKEN;
  });
}

export async function resolveChatGPTRequestIdentity(
  options: Partial<ChatGPTPluginOptions> | undefined,
  inbound: string | null,
  fetchImpl: RuntimeFetch = globalThis.fetch,
): Promise<{ readonly userAgent: string; readonly clientVersion: string }> {
  const configured = options?.userAgent?.trim();
  const template = codexVersionTemplate(
    configured === undefined || configured === '' ? DEFAULT_CHATGPT_USER_AGENT : configured,
  );
  const asksForLatest = template.includes(LATEST_CODEX_RS_VERSION_TOKEN);
  const clientVersion = asksForLatest ? await latestCodexRsVersion(fetchImpl) : CODEX_CLIENT_VERSION;
  const userAgent = asksForLatest ? template.replaceAll(LATEST_CODEX_RS_VERSION_TOKEN, clientVersion) : template;
  if (options?.userAgentPolicy !== 'preserveCodexClient' || inbound === null) return { userAgent, clientVersion };
  const normalized = inbound.toLowerCase();
  return {
    userAgent: CODEX_CLIENT_MARKERS.some((marker) => normalized.includes(marker)) ? inbound : userAgent,
    clientVersion,
  };
}
