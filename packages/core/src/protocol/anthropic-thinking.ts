import { AnthropicMessagesTransformError } from '../error';
import type { AnthropicMessagesRequest } from '../ingress/anthropic-messages/index';

export type AnthropicThinkingOption =
  | { readonly mode: 'disabled' }
  | { readonly mode: 'fixed'; readonly budgetTokens: number }
  | { readonly mode: 'adaptive'; readonly effort: string };

export function anthropicThinkingOption(
  request: Pick<AnthropicMessagesRequest, 'thinking' | 'output_config' | 'max_tokens'>,
): AnthropicThinkingOption | undefined {
  const effort = request.output_config?.effort;
  const thinking = request.thinking;
  if (thinking === undefined) {
    if (effort !== undefined) invalid('output_config.effort');
    return undefined;
  }

  switch (thinking.type) {
    case 'disabled':
      return { mode: 'disabled' };
    case 'enabled':
      if (
        effort !== undefined ||
        !Number.isInteger(thinking.budget_tokens) ||
        thinking.budget_tokens < 1024 ||
        request.max_tokens === undefined ||
        thinking.budget_tokens >= request.max_tokens
      ) {
        invalid('thinking.budget_tokens');
      }
      return { mode: 'fixed', budgetTokens: thinking.budget_tokens };
    case 'adaptive':
      if (effort === undefined) invalid('output_config.effort');
      return { mode: 'adaptive', effort };
    default:
      return invalid('thinking.type');
  }
}

function invalid(path: string): never {
  throw new AnthropicMessagesTransformError(path);
}
