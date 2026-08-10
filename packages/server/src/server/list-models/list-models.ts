import type { ModelInfo as AnthropicModelInfo } from '@anthropic-ai/sdk/resources/models';
import { getUnixTime, isValid, parseISO } from 'date-fns';
import type { Model as OpenAIModel } from 'openai/resources/models';

import type { ServerState } from '../../server-state';
import { type ModelCapabilitiesSubset, toAnthropicCapabilitiesFromMetadata } from '../model-capabilities';
import {
  resolveAggregatedLimit,
  resolveEnabledModels,
  resolveModelCapabilities,
  resolveModelField,
} from '../model-resolution/index';

const unknownCreatedAt = '1970-01-01T00:00:00Z';

type ModelListItem = OpenAIModel &
  Omit<AnthropicModelInfo, 'capabilities'> & {
    readonly capabilities: ModelCapabilitiesSubset | null;
  };

export async function listModels(state: ServerState) {
  const resolved = await resolveEnabledModels(state);
  const data = resolved.map((model): ModelListItem => {
    const capabilities = resolveModelCapabilities(model);
    const displayName = resolveModelField(model, (metadata) => metadata.name) ?? model.slug;
    const releaseDate = resolveModelField(model, (metadata) => metadata.capabilities?.releaseDate);
    const timestamps = modelTimestamps(releaseDate);
    return {
      capabilities: capabilities === undefined ? null : toAnthropicCapabilitiesFromMetadata({ capabilities }),
      created: timestamps.created,
      created_at: timestamps.createdAt,
      display_name: displayName,
      id: model.slug,
      max_input_tokens: resolveAggregatedLimit(model, 'input') ?? null,
      max_tokens: resolveAggregatedLimit(model, 'output') ?? null,
      object: 'model',
      owned_by: model.provider.id,
      type: 'model',
    };
  });
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
    object: 'list' as const,
  };
}

function modelTimestamps(releaseDate: string | undefined): { readonly created: number; readonly createdAt: string } {
  if (releaseDate === undefined) {
    return { created: 0, createdAt: unknownCreatedAt };
  }
  const normalizedDate = releaseDate.length === 7 ? `${releaseDate}-01` : releaseDate;
  const date = parseISO(`${normalizedDate}T00:00:00Z`);
  if (!isValid(date)) {
    return { created: 0, createdAt: unknownCreatedAt };
  }
  return { created: getUnixTime(date), createdAt: date.toISOString() };
}
