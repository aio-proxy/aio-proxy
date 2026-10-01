import type { CodexCatalog } from '@aio-proxy/server';
import { CodexUpstreamModelSchema } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import packageJson from '../../../../package.json' with { type: 'json' };
import { codexBaseUrl } from '../../control-plane';

export type CodexCatalogFetchInput = {
  readonly endpoint: string;
  readonly token: string;
  readonly signal: AbortSignal;
};

export async function fetchCodexCatalog(
  input: CodexCatalogFetchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexCatalog> {
  const url = new URL(`${codexBaseUrl(input.endpoint)}/models`);
  url.searchParams.set('client_version', packageJson.version);
  url.searchParams.set('codex_instructions', 'full');
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${input.token}` },
    signal: input.signal,
  });
  if (!response.ok) throw new Error('CODEX_CATALOG_FETCH_FAILED');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('CODEX_CATALOG_INVALID');
  }
  if (!isPlainObject(body) || !Array.isArray(body['models'])) throw new Error('CODEX_CATALOG_INVALID');
  const models = body['models'].map((row: unknown) => {
    const parsed = CodexUpstreamModelSchema.safeParse(row);
    if (!parsed.success) throw new Error('CODEX_CATALOG_INVALID');
    const model = parsed.data;
    const messages = model['model_messages'];
    if (
      typeof model['base_instructions'] !== 'string' ||
      (messages !== undefined && messages !== null && !isPlainObject(messages)) ||
      (isPlainObject(messages) &&
        'instructions_template' in messages &&
        typeof messages['instructions_template'] !== 'string')
    )
      throw new Error('CODEX_CATALOG_INVALID');
    return model;
  });
  return { models };
}
