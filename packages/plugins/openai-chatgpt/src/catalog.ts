import { type CredentialPort, type ModelDescriptor, type RuntimeFetch, zod } from '@aio-proxy/plugin-sdk';
import { CodexLeanModelSchema } from '@aio-proxy/types';
import { map, pipe, sortBy } from 'es-toolkit/fp';

import { CHATGPT_USER_AGENT, CODEX_CLIENT_VERSION } from './codex-client';
import { currentCredential } from './runtime/index';
import type { ChatGPTCredential } from './schema';

export const CODEX_MODELS_ENDPOINT = 'https://chatgpt.com/backend-api/codex/models';
export const CHATGPT_CATALOG_TTL_MS = 6 * 60 * 60_000;

const CodexModelsSchema = zod.object({
  models: zod.array(CodexLeanModelSchema),
});

/**
 * The account's own model list, not the published defaults. The static
 * `models-manager/models.json` on GitHub describes what some codex build ships
 * with and drifts from a real account in both directions, so it is not a usable
 * source: it advertises models the account cannot call and omits ones it can.
 *
 * `supported_in_api` is deliberately NOT filtered. Upstream short-circuits it
 * for ChatGPT auth (`filter_by_auth(models, chatgpt_mode)` keeps everything when
 * `chatgpt_mode`), so it describes API-key access, not ChatGPT access — filtering
 * on it hides models such as `gpt-5.3-codex-spark` that the account can use.
 *
 * `visibility: 'hide'` is also kept: it is a codex-TUI picker hint, not an
 * access control, and the host already lets users hide models via
 * `excludedModels`.
 */
export async function discoverOpenAIChatGPTModels(
  credentials: CredentialPort<ChatGPTCredential>,
  signal: AbortSignal,
  fetch: RuntimeFetch = globalThis.fetch,
): Promise<readonly ModelDescriptor[]> {
  const credential = await currentCredential(credentials, fetch);
  const url = new URL(CODEX_MODELS_ENDPOINT);
  // Required: the endpoint 400s without it, and gates each model on its
  // `minimal_client_version`.
  url.searchParams.set('client_version', CODEX_CLIENT_VERSION);
  const response = await fetch(url, {
    signal,
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-Id': credential.accountId,
      Originator: 'codex-tui',
      'User-Agent': CHATGPT_USER_AGENT,
      'session-id': crypto.randomUUID(),
    },
    aioProxy: { traffic: 'control' },
  });
  if (!response.ok) throw new Error(`Codex model catalog request failed with ${response.status}`);
  const { models } = CodexModelsSchema.parse(await response.json());
  // The endpoint answers 200 with an empty array when no model clears
  // `minimal_client_version`, so an empty list is a failed discovery, not an
  // account with no models: swapping it in would drop every language model.
  if (models.length === 0) throw new Error('Codex model catalog returned no models');
  return pipe(
    models,
    sortBy([(model) => model.priority]),
    map((model): ModelDescriptor => ({
      id: model.slug,
      displayName: model.display_name,
      extra: { protocol: 'openai-response' },
    })),
  );
}

/**
 * Hardcoded, and permanently so. The Codex models endpoint describes language
 * models only — its `ModelInfo` carries `input_modalities` but no output
 * modality — so it structurally cannot report an image model, and `gpt-image-2`
 * appears in neither the endpoint nor the published `models.json`. codex itself
 * hardcodes the id (`IMAGE_MODEL`), as does every reference proxy. Meanwhile
 * `/backend-api/codex/images/generations` serves it for the same account.
 *
 * The upstream `model` field is decorative: every value tested returned the same
 * gpt-image 2.0 output. The id exists so users have something to route to.
 *
 * No `extra.protocol`. The host does hand this descriptor's `extra` to the raw
 * resolver — for an inbound `openai-image` it resolves the descriptor from the
 * image catalog first and spreads `extra` into the resolver input
 * (`plugin-runtime/capabilities.ts:62-63,68`). This plugin's resolver ignores
 * `extra` and matches on the inbound protocol, so a `protocol` here would reach
 * it and be dropped. Omitted rather than carried as a decorative field.
 */
export const CHATGPT_IMAGE_MODELS: readonly ModelDescriptor[] = [
  {
    id: 'gpt-image-2',
    displayName: 'GPT Image 2',
    modelMetadata: {
      capabilities: { modalities: { input: ['text', 'image'], output: ['image'] } },
    },
  },
];
