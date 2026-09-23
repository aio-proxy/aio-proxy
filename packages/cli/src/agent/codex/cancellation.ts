import { PromptCancelledError } from '../../ui';

export function isCodexCancellation(error: unknown): boolean {
  return error instanceof PromptCancelledError || (error instanceof Error && error.name === 'AbortError');
}
