import { BUNDLED_PROVIDERS, createProxyFetch, loadAiSdkProvider } from '@aio-proxy/core';
import {
  type AiSdkProvider,
  type ApiProvider,
  apiProviderEndpoints,
  type Config,
  ProviderKind,
  ProviderProtocol,
} from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';
import { isPlainObject } from 'es-toolkit/predicate';

import { effectiveProxy, materializeProviders } from '../provider-runtime';

export type ProviderModelDiscovery =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly code: 'catalog_unsupported' | 'catalog_unavailable' };

export async function discoverProviderModels(
  config: Config,
  provider: ApiProvider | AiSdkProvider,
  signal: AbortSignal,
  options: { readonly strict: boolean },
): Promise<ProviderModelDiscovery> {
  if (provider.kind === ProviderKind.AiSdk) return loadAiSdkCatalog(config, provider, signal, options.strict);

  try {
    const primary = apiProviderEndpoints(provider)[0];
    const runtime = materializeProviders({
      ...config,
      invalidProviders: [],
      providers: [{ ...provider, enabled: true }],
    }).providers[0];
    const raw = runtime?.raw?.resolve({ protocol: primary.protocol, modelId: '' });
    if (raw === undefined) return { ok: false, code: 'catalog_unavailable' };
    const models: string[] = [];
    let path: string | undefined = catalogPath(primary.protocol);
    while (path !== undefined) {
      const response = await raw.invoke(new Request(`http://provider-draft.invalid${path}`, { signal }), undefined, {
        upstreamStream: false,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, code: 'catalog_unavailable' };
      }
      const page = catalogPage(primary.protocol, await response.json(), options.strict);
      models.push(...page.models);
      path = page.nextPath;
    }
    return { ok: true, models: uniq(models) };
  } catch {
    return { ok: false, code: 'catalog_unavailable' };
  }
}

// The AI SDK contract does not standardize model discovery. Custom packages may
// expose listModels(signal?) on their provider instance; otherwise retain the
// existing OpenAI-compatible options.baseURL + /models convention.
async function loadAiSdkCatalog(
  config: Config,
  provider: AiSdkProvider,
  signal: AbortSignal,
  strict: boolean,
): Promise<ProviderModelDiscovery> {
  // Discovery establishes no provider attempt, debug scope, or response observation,
  // so the runtime's transform and observation fetch wrappers would be inert here.
  const fetchWithProxy = createProxyFetch(effectiveProxy(config.proxy, provider.proxy, config, provider));
  let extensionUnavailable = false;
  if (BUNDLED_PROVIDERS[provider.packageName] === undefined) {
    try {
      const runtime = await loadAiSdkProvider(provider.packageName, {
        ...provider.options,
        fetch: fetchWithProxy,
      });
      if (typeof runtime?.listModels === 'function') {
        const models = catalogEntryIds(await runtime.listModels(signal), strict);
        if (models !== null) return { ok: true, models };
        // Strict discovery must not hide a corrupt extension result behind a fallback.
        if (strict) return { ok: false, code: 'catalog_unavailable' };
        extensionUnavailable = true;
      }
    } catch {
      extensionUnavailable = true;
    }
  }

  const baseURL = provider.options?.['baseURL'];
  if (typeof baseURL !== 'string' || baseURL.trim() === '') {
    return { ok: false, code: extensionUnavailable ? 'catalog_unavailable' : 'catalog_unsupported' };
  }
  try {
    const response = await fetchWithProxy(`${baseURL.replace(/\/+$/u, '')}/models`, {
      signal,
      headers: catalogHeaders(provider.options),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, code: 'catalog_unavailable' };
    }
    const page = catalogPage(ProviderProtocol.OpenAICompatible, await response.json(), strict);
    return { ok: true, models: uniq(page.models) };
  } catch {
    return { ok: false, code: 'catalog_unavailable' };
  }
}

function catalogEntryIds(rows: unknown, strict: boolean): readonly string[] | null {
  if (!Array.isArray(rows)) return null;
  const models: string[] = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row : isPlainObject(row) ? row['id'] : undefined;
    if (typeof id !== 'string' || id.trim() === '') {
      if (strict) return null;
      continue;
    }
    models.push(id);
  }
  return uniq(models);
}

// apiKey first, configured headers second — runtime requests and the AI SDK
// resolve the collision this way. Headers.set replaces Authorization in any casing.
function catalogHeaders(options: Readonly<Record<string, unknown>> | undefined): Headers {
  const headers = new Headers();
  const apiKey = options?.['apiKey'];
  if (typeof apiKey === 'string' && apiKey !== '') headers.set('authorization', `Bearer ${apiKey}`);
  const configured = options?.['headers'];
  if (isPlainObject(configured)) {
    for (const [name, value] of Object.entries(configured)) headers.set(name, String(value));
  }
  return headers;
}

function geminiCatalog(protocol: ProviderProtocol): boolean {
  return protocol === ProviderProtocol.Gemini || protocol === ProviderProtocol.GeminiInteractions;
}

function catalogPath(protocol: ProviderProtocol): string {
  return geminiCatalog(protocol) ? '/v1beta/models' : '/v1/models';
}

type CatalogPage = {
  readonly models: readonly string[];
  readonly nextPath?: string;
};

function catalogPage(protocol: ProviderProtocol, payload: unknown, strict: boolean): CatalogPage {
  const models = catalogModels(protocol, payload, strict);
  const pageToken = stringProperty(payload, 'nextPageToken', strict);
  const hasMore = booleanProperty(payload, 'has_more', strict);
  const afterId = stringProperty(payload, 'last_id', strict);
  if (geminiCatalog(protocol)) {
    return pageToken === undefined
      ? { models }
      : { models, nextPath: `/v1beta/models?pageToken=${encodeURIComponent(pageToken)}` };
  }
  if (protocol === ProviderProtocol.Anthropic && hasMore) {
    if (afterId === undefined) throw new TypeError('invalid catalog continuation');
    return { models, nextPath: `/v1/models?after_id=${encodeURIComponent(afterId)}` };
  }
  return { models };
}

function stringProperty(payload: unknown, key: string, strict: boolean): string | undefined {
  if (!isPlainObject(payload)) throw new TypeError('invalid catalog');
  const value = payload[key];
  if (strict && key in payload && typeof value !== 'string') throw new TypeError('invalid catalog pagination');
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function booleanProperty(payload: unknown, key: string, strict: boolean): boolean {
  if (!isPlainObject(payload)) throw new TypeError('invalid catalog');
  const value = payload[key];
  if (strict && key in payload && typeof value !== 'boolean') throw new TypeError('invalid catalog pagination');
  return value === true;
}

function catalogModels(protocol: ProviderProtocol, payload: unknown, strict: boolean): readonly string[] {
  if (!isPlainObject(payload)) throw new TypeError('invalid catalog');
  const gemini = geminiCatalog(protocol);
  const rows = payload[gemini ? 'models' : 'data'];
  if (!Array.isArray(rows)) throw new TypeError('invalid catalog');
  const models = rows.flatMap((row) => {
    const value = isPlainObject(row) ? row[gemini ? 'name' : 'id'] : undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      if (strict) throw new TypeError('invalid catalog model');
      return [];
    }
    return [gemini ? value.replace(/^models\//u, '') : value];
  });
  return uniq(models);
}
