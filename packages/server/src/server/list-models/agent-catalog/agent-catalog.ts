import type { AgentCatalogV1, AgentTarget } from '@aio-proxy/types';

import type { ServerState } from '../../../server-state';
import {
  resolveAggregatedLimit,
  resolveEnabledModels,
  resolveModelCapabilities,
  resolveModelField,
} from '../../model-resolution/index';

export async function agentCatalog(state: ServerState, agent: AgentTarget): Promise<AgentCatalogV1> {
  const resolved = await resolveEnabledModels(state);
  return {
    schema_version: 1,
    agent,
    models: resolved.map((model) => {
      const capabilities = resolveModelCapabilities(model);
      return {
        id: model.slug,
        name: resolveModelField(model, (metadata) => metadata.name) ?? model.slug,
        reasoning: capabilities?.reasoning ?? false,
        tool_call: capabilities?.toolCall ?? true,
        temperature: capabilities?.temperature ?? false,
        attachment: capabilities?.attachment ?? false,
        input: capabilities?.modalities?.input ?? ['text'],
        context_window: resolveAggregatedLimit(model, 'context') ?? null,
        max_output_tokens: resolveAggregatedLimit(model, 'output') ?? null,
      };
    }),
  };
}
