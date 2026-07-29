import type { Model, ProviderMap } from '@opencode-ai/models';

import type { OpenRouterModelPrice } from '../usage-pricing';
import { resolveModel } from './resolve';

// Pricing resolves a model id through the same provider resolution as the rest
// of models.dev (explicit provider/model, then a `gpt-`/`claude-`/`gemini-`
// prefix pin, then the OpenRouter catalog). This keeps billing aligned with how
// the alias/variant targets and requested aliases are looked up elsewhere, so
// e.g. a `claude-*` id is priced from the Anthropic catalog instead of silently
// missing because it only exists there.
export function findModelPrice(providers: ProviderMap, modelId: string): OpenRouterModelPrice | undefined {
  const model = resolveModel(providers, modelId);
  return model === undefined ? undefined : toPrice(model);
}

function toPrice(model: Model): OpenRouterModelPrice | undefined {
  if (model.cost === undefined) return undefined;
  const cost = model.cost;
  return {
    id: model.id,
    input: cost.input,
    output: cost.output,
    ...(cost.cache_read === undefined ? {} : { cacheRead: cost.cache_read }),
    ...(cost.cache_write === undefined ? {} : { cacheWrite: cost.cache_write }),
    ...(cost.reasoning === undefined ? {} : { reasoning: cost.reasoning }),
  };
}
