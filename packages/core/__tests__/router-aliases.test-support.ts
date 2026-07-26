import { ProviderProtocol } from '@aio-proxy/types';

import type { ProviderInstance } from '../src/index';

export const legacyOAuth = {
  kind: 'oauth',
  id: 'legacy-oauth',
  vendor: 'legacy-provider',
  models: ['claude-sonnet-4-5'],
  alias: { sonnet: { model: 'claude-sonnet-4-5', preserve: false } },
} satisfies ProviderInstance;

export const openai = {
  kind: 'api',
  id: 'openai',
  protocol: ProviderProtocol.OpenAIResponse,
  models: ['gpt-5-mini'],
  alias: { mini: { model: 'gpt-5-mini', preserve: true } },
} satisfies ProviderInstance;
