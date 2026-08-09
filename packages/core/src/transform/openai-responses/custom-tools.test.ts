import { expect, spyOn, test } from 'bun:test';

import {
  OpenAIResponsesUnsupportedFeatureError,
  openAIResponsesToModelMessages,
  parseOpenAIResponses,
} from '../../index';

test('converts custom call history without a matching custom tool declaration', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  // Codex compaction turns replay prior custom_tool_call history while sending
  // `tools: []`; the transform must tolerate the undeclared call instead of 501ing.
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: [
      { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: 'pwd' },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'done' },
    ],
  });

  try {
    const converted = openAIResponsesToModelMessages(request);
    expect(converted.tools).toBeUndefined();
    expect(converted.messages).toMatchObject([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'apply_patch', input: { input: 'pwd' } }],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'apply_patch' }] },
    ]);
  } finally {
    warn.mockRestore();
  }
});

test('rejects custom tool formats unsupported by the pinned OpenAI SDK', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const request = parseOpenAIResponses({
    model: 'gpt-5.6-terra',
    input: 'hello',
    tools: [{ type: 'custom', name: 'exec', format: { type: 'unknown' } }],
  });

  try {
    expect(() => openAIResponsesToModelMessages(request)).toThrow(
      new OpenAIResponsesUnsupportedFeatureError('custom_tool.format', 'tools.0.format'),
    );
  } finally {
    warn.mockRestore();
  }
});
