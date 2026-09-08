import { describe, expect, test } from 'bun:test';

import type { LogicalRequestContext, ModelCatalog } from '@aio-proxy/plugin-sdk';

import { bindAntigravityThinking } from '../protocol/thinking';
import { createAntigravityLanguageModel, synthesizeThinking } from './google-model';
import {
  captureStreamTransport,
  captureTransport,
  collect,
  logicalContext,
  textResponse,
} from './provider.test-support';
import type { CcaTransport } from './transport';

describe('synthesizeThinking', () => {
  test('prefers an explicit thinking option over both effort sources', () => {
    expect(synthesizeThinking({ mode: 'fixed', budgetTokens: 2048 }, 'max', 'high')).toEqual({
      mode: 'fixed',
      budgetTokens: 2048,
    });
  });

  test('uses the canonical effort so max survives the AI SDK ceiling', () => {
    expect(synthesizeThinking(undefined, 'max', 'xhigh')).toEqual({ mode: 'adaptive', effort: 'max' });
  });

  test('maps a canonical none onto disabled thinking', () => {
    expect(synthesizeThinking(undefined, 'none', 'none')).toEqual({ mode: 'disabled' });
  });

  test('falls back to the SDK reasoning when no canonical effort was carried', () => {
    expect(synthesizeThinking(undefined, undefined, 'high')).toEqual({ mode: 'adaptive', effort: 'high' });
    expect(synthesizeThinking(undefined, undefined, 'provider-default')).toBeUndefined();
    expect(synthesizeThinking(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe('canonical effort reaches the wire', () => {
  // `xhigh` is the AI SDK union's ceiling and folds to the `high` budget (16_384).
  // Only the canonical `aioProxy.effort` can reach the `max` budget (32_768), so a
  // 16_384 result here means the private channel stopped being read.
  test('doGenerate spends the max budget the AI SDK reasoning union cannot express', async () => {
    const captured = captureTransport(textResponse('ok'));
    const model = createAntigravityLanguageModel('claude-sonnet-4-6', claudeRuntime(captured.transport));

    await model.doGenerate(maxEffortCall());

    expect(captured.calls[0]?.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingBudget: 32_768, includeThoughts: true } },
    });
  });

  test('doStream spends the max budget the AI SDK reasoning union cannot express', async () => {
    const captured = captureStreamTransport([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] },
    ]);
    const model = createAntigravityLanguageModel('claude-sonnet-4-6', claudeRuntime(captured.transport));

    await collect((await model.doStream(maxEffortCall())).stream);

    expect(captured.calls[0]?.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingBudget: 32_768, includeThoughts: true } },
    });
  });
});

function maxEffortCall() {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    reasoning: 'xhigh',
    providerOptions: { aioProxy: { logicalRequest: logicalContext(), effort: 'max' } },
  } as never;
}

function claudeRuntime(transport: CcaTransport) {
  const catalog = claudeCatalog();
  return {
    call: (context: LogicalRequestContext) => ({
      catalog,
      context,
      thinkingBinder: bindAntigravityThinking(catalog),
      transport,
    }),
  };
}

function claudeCatalog(): ModelCatalog {
  return {
    language: [{ id: 'claude-sonnet-4-6', extra: { antigravity: { apiProvider: 'anthropic' } } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}
