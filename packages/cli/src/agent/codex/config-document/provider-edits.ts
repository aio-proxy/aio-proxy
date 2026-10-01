import { CodexProviderIdSchema } from '@aio-proxy/types';

import type { CodexAuthConfig } from '../contracts';
import type { FieldEdit, ManagedValue } from './config-document';

function catalogUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`;
    url.hash = '';
    return url.toString();
  } catch {
    return `${baseUrl.replace(/\/+$/u, '')}/models`;
  }
}

export function codexProviderEdits(
  providerId: string,
  baseUrl: string,
  auth: CodexAuthConfig,
  catalogPath?: string,
): readonly FieldEdit[] {
  const id = validateCodexProviderId(providerId);
  if (auth.mode === 'keep-chatgpt' && auth.token.length === 0) throw new Error('Codex bearer token cannot be empty');
  const fields: Record<string, ManagedValue> = {
    name: 'AIO Proxy',
    base_url: baseUrl,
    model_catalog_url: catalogUrl(baseUrl),
    wire_api: 'responses',
  };
  return [
    ...(catalogPath === undefined
      ? []
      : [{ path: ['model_catalog_json'], next: { present: true as const, value: catalogPath } }]),
    { path: ['model_provider'], next: { present: true, value: id } },
    { path: ['features', 'api_key_model_discovery'], next: { present: true, value: true } },
    ...Object.entries(fields).map(([key, value]) => ({
      path: ['model_providers', id, key],
      next: { present: true as const, value },
    })),
    {
      path: ['model_providers', id, 'requires_openai_auth'],
      next: auth.mode === 'keep-chatgpt' ? { present: true, value: true } : { present: false },
    },
    {
      path: ['model_providers', id, 'experimental_bearer_token'],
      next: auth.mode === 'keep-chatgpt' ? { present: true, value: auth.token } : { present: false },
    },
    {
      path: ['model_providers', id, 'auth', 'command'],
      next: auth.mode === 'command' ? { present: true, value: auth.command } : { present: false },
    },
    {
      path: ['model_providers', id, 'auth', 'args'],
      next:
        auth.mode === 'command'
          ? { present: true, value: ['agent', 'auth', 'codex', '--installation-id', auth.installationId] }
          : { present: false },
    },
    {
      path: ['model_providers', id, 'auth', 'timeout_ms'],
      next: auth.mode === 'command' ? { present: true, value: 5000 } : { present: false },
    },
    {
      path: ['model_providers', id, 'auth', 'refresh_interval_ms'],
      next: auth.mode === 'command' ? { present: true, value: 300000 } : { present: false },
    },
  ];
}

export function validateCodexProviderId(value: string): string {
  const parsed = CodexProviderIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const reason = parsed.error.issues[0]?.message;
  if (reason === 'control_character') throw new Error('Codex provider ID cannot contain control characters');
  if (reason === 'reserved') throw new Error(`Codex provider ID is reserved: ${value.trim()}`);
  throw new Error('Codex provider ID cannot be empty');
}
