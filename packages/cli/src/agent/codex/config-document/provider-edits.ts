import type { CodexAuthConfig } from '../contracts';
import type { FieldEdit, ManagedValue } from './config-document';

export function codexProviderEdits(providerId: string, baseUrl: string, auth: CodexAuthConfig): readonly FieldEdit[] {
  const id = validateCodexProviderId(providerId);
  if (auth.mode === 'keep-chatgpt' && auth.token.length === 0) throw new Error('Codex bearer token cannot be empty');
  const fields: Record<string, ManagedValue> = {
    name: 'AIO Proxy',
    base_url: baseUrl,
    wire_api: 'responses',
  };
  return [
    { path: ['model_provider'], next: { present: true, value: id } },
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
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  if (hasControlCharacter) throw new Error('Codex provider ID cannot contain control characters');
  const id = value.trim();
  if (id.length === 0) throw new Error('Codex provider ID cannot be empty');
  if (new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock']).has(id)) {
    throw new Error(`Codex provider ID is reserved: ${id}`);
  }
  return id;
}
