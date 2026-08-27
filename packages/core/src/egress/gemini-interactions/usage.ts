import type { TextStreamPart, ToolSet } from '../../ai-sdk-bridge';

export type InteractionUsage = {
  readonly total_input_tokens: number;
  readonly total_output_tokens: number;
  readonly total_tokens: number;
  readonly total_thought_tokens: number;
  readonly total_cached_tokens: number;
  readonly total_tool_use_tokens: number;
};

type TokenUsage = Extract<TextStreamPart<ToolSet>, { type: 'finish' }>['totalUsage'];

export function interactionUsage(totalUsage: TokenUsage | undefined): InteractionUsage {
  const input = totalUsage?.inputTokens ?? 0;
  const thought = totalUsage?.outputTokenDetails?.reasoningTokens ?? 0;
  const output = outputTokensExcludingThought(totalUsage, thought);
  return {
    total_input_tokens: input,
    total_output_tokens: output,
    total_thought_tokens: thought,
    total_cached_tokens: totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
    total_tool_use_tokens: 0,
    total_tokens: totalUsage?.totalTokens ?? input + output + thought,
  };
}

function outputTokensExcludingThought(usage: TokenUsage | undefined, thought: number): number {
  const textTokens = usage?.outputTokenDetails?.textTokens;
  if (textTokens !== undefined) return textTokens;
  const output = usage?.outputTokens;
  if (output !== undefined && usage?.outputTokenDetails?.reasoningTokens !== undefined) {
    return output - thought;
  }
  return output ?? 0;
}
