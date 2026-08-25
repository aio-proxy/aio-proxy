export type InteractionStatus = 'completed' | 'requires_action' | 'incomplete' | 'error';

export function interactionStatus(finishReason: string, unmatchedFunctionCall: boolean): InteractionStatus {
  if (finishReason === 'error') return 'error';
  if (unmatchedFunctionCall || finishReason === 'tool-calls') return 'requires_action';
  if (finishReason === 'length' || finishReason === 'content-filter') return 'incomplete';
  if (finishReason === 'stop') return 'completed';
  return 'error';
}
