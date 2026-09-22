export type AgentModelProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export function resolveAgentModelProtocol(modelId: string): AgentModelProtocol {
  if (modelId.startsWith('gpt-')) return 'openai-responses';
  if (modelId.startsWith('claude-')) return 'anthropic-messages';
  if (modelId.startsWith('gemini-')) return 'google-generative-ai';
  return 'openai-completions';
}
