import type { LanguageModelV4ToolResultPart } from '@ai-sdk/provider';

export function toolResultText(part: LanguageModelV4ToolResultPart): string {
  const output = part.output;
  if (output.type === 'execution-denied') {
    return `[Tool Execution Denied]\n${output.reason?.trim() || 'Tool execution was denied.'}`;
  }
  const body =
    output.type === 'text' || output.type === 'error-text'
      ? output.value
      : output.type === 'json' || output.type === 'error-json'
        ? JSON.stringify(output.value)
        : output.type === 'content'
          ? output.value.map((entry) => (entry.type === 'text' ? entry.text : `[${entry.type}]`)).join('\n')
          : '';
  const trimmed = body.trim();
  const prefix = output.type === 'error-text' || output.type === 'error-json' ? '[Tool Error]' : '[Tool Result]';
  return `${prefix}\n${trimmed || '(no output)'}`;
}

export function rootToolResult(part: LanguageModelV4ToolResultPart): { result: unknown; isError?: true } {
  const out = part.output;
  switch (out.type) {
    case 'json':
      return { result: out.value };
    case 'error-json':
      return { result: out.value, isError: true };
    case 'text':
      return { result: out.value.trim() ? out.value : '(no output)' };
    case 'error-text':
      return { result: out.value.trim() ? out.value : '(no output)', isError: true };
    case 'execution-denied':
      return {
        result: '[Tool Execution Denied]\n' + (out.reason?.trim() || 'Tool execution was denied.'),
        isError: true,
      };
    case 'content': {
      const text = out.value.map((entry) => (entry.type === 'text' ? entry.text : '[' + entry.type + ']')).join('\n');
      return { result: text.trim() ? text : '(no output)' };
    }
  }
}
