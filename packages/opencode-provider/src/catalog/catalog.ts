import type { AgentCatalogV1 } from '@aio-proxy/types';
import type { Config } from '@opencode-ai/plugin';

type OpenCodeModelConfig = NonNullable<NonNullable<Config['provider']>[string]['models']>[string];
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 32_768;

export function toOpenCodeModels(catalog: AgentCatalogV1): Record<string, OpenCodeModelConfig> {
  return Object.fromEntries(
    catalog.models.map((model) => {
      const context = model.context_window ?? DEFAULT_CONTEXT;
      return [
        model.id,
        {
          name: model.name,
          reasoning: model.reasoning,
          tool_call: model.tool_call,
          temperature: model.temperature,
          attachment: model.attachment,
          modalities: { input: [...model.input], output: ['text'] },
          limit: { context, output: Math.min(context, model.max_output_tokens ?? DEFAULT_OUTPUT) },
        },
      ];
    }),
  );
}

export const openCodeCatalogDigest = (catalog: AgentCatalogV1 | null): string =>
  catalog === null ? 'missing' : JSON.stringify(catalog.models);
