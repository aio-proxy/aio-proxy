import { type ModelDescriptor, zod } from "@aio-proxy/plugin-sdk";
import { filter, map, pipe, sortBy } from "es-toolkit/fp";

export const CODEX_MODELS_URL =
  "https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json";
export const CHATGPT_CATALOG_TTL_MS = 6 * 60 * 60_000;

const CodexModelsSchema = zod.object({
  models: zod.array(
    zod.object({
      slug: zod.string().min(1),
      display_name: zod.string().min(1),
      priority: zod.number(),
      supported_in_api: zod.boolean(),
      visibility: zod.string(),
    }),
  ),
});

export async function discoverOpenAIChatGPTModels(signal: AbortSignal): Promise<readonly ModelDescriptor[]> {
  const response = await fetch(CODEX_MODELS_URL, { signal });
  if (!response.ok) throw new Error(`Codex model catalog request failed with ${response.status}`);
  const { models } = CodexModelsSchema.parse(await response.json());
  return pipe(
    models,
    filter((model) => model.supported_in_api),
    sortBy([(model) => model.priority]),
    map((model) => ({ id: model.slug, displayName: model.display_name })),
  );
}
