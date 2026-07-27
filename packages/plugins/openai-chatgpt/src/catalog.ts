import { type ModelDescriptor, zod } from '@aio-proxy/plugin-sdk';
import { CodexLeanModelSchema } from '@aio-proxy/types';
import { filter, map, pipe, sortBy } from 'es-toolkit/fp';

export const CODEX_MODELS_URL =
  'https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json';
export const CHATGPT_CATALOG_TTL_MS = 6 * 60 * 60_000;

const CodexModelsSchema = zod.object({
  models: zod.array(CodexLeanModelSchema),
});

export async function discoverOpenAIChatGPTModels(signal: AbortSignal): Promise<readonly ModelDescriptor[]> {
  const response = await fetch(CODEX_MODELS_URL, { signal });
  if (!response.ok) throw new Error(`Codex model catalog request failed with ${response.status}`);
  const { models } = CodexModelsSchema.parse(await response.json());
  return pipe(
    models,
    filter((model) => model.supported_in_api),
    sortBy([(model) => model.priority]),
    map(
      (model): ModelDescriptor => ({
        id: model.slug,
        displayName: model.display_name,
        metadata: { protocol: 'openai-response' },
      }),
    ),
  );
}
