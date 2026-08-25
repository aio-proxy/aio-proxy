import type { AliasDimensions } from '@aio-proxy/types';

import type { AiSdkCallSettings, ModelMessage } from '../../ai-sdk-bridge';
import type { GeminiInteractionsBody, GeminiInteractionsRequest } from '../../ingress/gemini-interactions/index';
import { assertGeminiInteractionsConvertible } from './eligibility';
import { geminiInteractionsInputToMessages } from './input';

export type GeminiInteractionsTransformTool = {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
};

export type GeminiInteractionsTransformSettings = {
  readonly maxOutputTokens?: number;
  readonly seed?: number;
  readonly stopSequences?: string[];
  readonly reasoning?: AiSdkCallSettings['reasoning'];
  readonly toolChoice?: 'auto' | 'none';
};

export type GeminiInteractionsModelMessages = {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly GeminiInteractionsTransformTool[];
  readonly settings: GeminiInteractionsTransformSettings;
  readonly dimensions: AliasDimensions;
};

export function geminiInteractionsToModelMessages(request: GeminiInteractionsRequest): GeminiInteractionsModelMessages {
  assertGeminiInteractionsConvertible(request);
  const tools = functionTools(request.body.tools);
  const { settings, dimensions } = callSettings(request.body.generation_config);
  return {
    messages: geminiInteractionsInputToMessages(request),
    ...(tools === undefined ? {} : { tools }),
    settings,
    dimensions,
  };
}

function functionTools(value: GeminiInteractionsBody['tools']): readonly GeminiInteractionsTransformTool[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool['name'] !== 'string') return [];
    return [
      {
        type: 'function' as const,
        name: tool['name'],
        ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
        ...(tool['parameters'] === undefined ? {} : { inputSchema: tool['parameters'] }),
      },
    ];
  });
}

function callSettings(value: GeminiInteractionsBody['generation_config']): {
  readonly settings: GeminiInteractionsTransformSettings;
  readonly dimensions: AliasDimensions;
} {
  if (!isRecord(value)) return { settings: {}, dimensions: {} };
  const toolChoice = toolChoiceSetting(value['tool_choice']);
  const thinkingLevel = typeof value['thinking_level'] === 'string' ? value['thinking_level'] : undefined;
  return {
    settings: {
      ...(typeof value['max_output_tokens'] === 'number' ? { maxOutputTokens: value['max_output_tokens'] } : {}),
      ...(typeof value['seed'] === 'number' ? { seed: value['seed'] } : {}),
      ...(Array.isArray(value['stop_sequences']) ? { stopSequences: value['stop_sequences'] as string[] } : {}),
      ...(thinkingLevel === undefined
        ? {}
        : { reasoning: thinkingLevel as NonNullable<AiSdkCallSettings['reasoning']> }),
      ...(toolChoice === undefined ? {} : { toolChoice }),
    },
    dimensions: thinkingLevel === undefined ? {} : { thinking: true, effort: thinkingLevel },
  };
}

function toolChoiceSetting(value: unknown): GeminiInteractionsTransformSettings['toolChoice'] {
  if (value === 'auto' || value === 'none') return value;
  if (!isRecord(value) || !isRecord(value['allowed_tools'])) return undefined;
  const mode = value['allowed_tools']['mode'];
  return mode === 'auto' || mode === 'none' ? mode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
