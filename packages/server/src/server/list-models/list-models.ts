import type { ModelInfo as AnthropicModelInfo } from '@anthropic-ai/sdk/resources/models';
import { getUnixTime, isValid, parseISO } from 'date-fns';
import type { Model as OpenAIModel } from 'openai/resources/models';

import type { ServerState } from '../../server-state';
import { type ModelCapabilitiesSubset, toAnthropicCapabilities } from '../model-capabilities';
import { resolveEnabledModels } from '../model-resolution/index';

const unknownCreatedAt = '1970-01-01T00:00:00Z';

type ModelListItem = OpenAIModel &
  Omit<AnthropicModelInfo, 'capabilities'> & {
    readonly capabilities: ModelCapabilitiesSubset | null;
  };

export async function listModels(state: ServerState) {
  const resolved = await resolveEnabledModels(state);
  const data = resolved.map(({ slug, provider, metadata, displayName }): ModelListItem => {
    const timestamps = modelTimestamps(metadata?.release_date);
    return {
      capabilities: metadata === undefined ? null : toAnthropicCapabilities(metadata),
      created: timestamps.created,
      created_at: timestamps.createdAt,
      display_name: displayName,
      id: slug,
      max_input_tokens: metadata === undefined ? null : (metadata.limit.input ?? metadata.limit.context),
      max_tokens: metadata?.limit.output ?? null,
      object: 'model',
      owned_by: provider.id,
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
