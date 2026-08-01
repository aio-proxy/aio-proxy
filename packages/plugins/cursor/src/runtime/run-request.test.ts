import { expect, test } from 'bun:test';

import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { fromBinary } from '@bufbuild/protobuf';

import { AgentClientMessageSchema } from '../gen/agent_pb';
import { buildCursorRunRequestBytes } from './run-request';

const decodeRun = (bytes: Uint8Array) => {
  const client = fromBinary(AgentClientMessageSchema, bytes);
  if (client.message.case !== 'runRequest') throw new Error('expected runRequest');
  return client.message.value;
};

test('a trailing user message selects userMessageAction', () => {
  const prompt: LanguageModelV4Prompt = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
  ];
  const { requestBytes } = buildCursorRunRequestBytes({
    prompt,
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: { conversationId: 'conv-1', blobStore: new Map() },
  });
  const run = decodeRun(requestBytes);
  expect(run.action?.action.case).toBe('userMessageAction');
  expect(run.conversationId).toBe('conv-1');
  expect(run.modelDetails?.modelId).toBe('claude-4.5-sonnet');
});

test('a trailing tool result selects resumeAction', () => {
  const prompt: LanguageModelV4Prompt = [
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: { q: 'x' } }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'search_docs',
          output: { type: 'json', value: { ok: true } },
        },
      ],
    },
  ];
  const { requestBytes } = buildCursorRunRequestBytes({
    prompt,
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: true,
    state: { conversationId: 'conv-2', blobStore: new Map() },
  });
  const run = decodeRun(requestBytes);
  expect(run.action?.action.case).toBe('resumeAction');
  expect(run.requestedModel?.maxMode).toBe(true);
});
