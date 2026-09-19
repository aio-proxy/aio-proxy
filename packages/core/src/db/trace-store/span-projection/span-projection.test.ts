import { describe, expect, test } from 'bun:test';

import { traceSpan } from '../../schema';
import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { mergeAttributes, projectAttributes } from './span-projection';

const TRACE_ID = 'a'.repeat(32);
const ROOT_SPAN_ID = 'b'.repeat(16);
const ATTEMPT_SPAN_ID = 'c'.repeat(16);
const STARTED_AT = new Date('2026-07-24T10:00:00.000Z');
const ENDED_AT = new Date('2026-07-24T10:00:00.100Z');

describe('span projection', () => {
  test('serves gen_ai.request.model from the legacy model_id column when it is not in the stored json', () => {
    // 老库里的 attempt span 把这个 key 抽进了 model_id 列，JSON 里没有。新写入反过来：
    // key 留在 JSON、列为空。两种行都得读出模型，所以列兜底不能跟着 root 一起删。
    expect(mergeAttributes({ modelId: 'legacy-model' }, {}, false)).toEqual({ 'gen_ai.request.model': 'legacy-model' });
    // 而 root 无论列里有什么都不再挂 gen_ai.*。
    expect(mergeAttributes({ modelId: 'legacy-model', requestedModelId: 'alias' }, {}, true)).toEqual({});
  });

  test('keeps routing v2 attributes in remaining attributes_json', () => {
    const attributes = {
      'aio_proxy.route.contract_version': 2,
      'aio_proxy.route.effective_priority': 30,
      'aio_proxy.route.effective_weight': 6000,
      'aio_proxy.route.priority_source': 'model',
      'aio_proxy.route.weight_source': 'provider',
      'aio_proxy.route.selection_source': 'deterministic_session',
    };

    const projected = projectAttributes(attributes, false);
    expect(projected.columns).toEqual({});
    expect(projected.remaining).toEqual(attributes);
    expect(mergeAttributes(projected.columns, projected.remaining, false)).toEqual(attributes);
  });

  test('keeps legacy provider weight and selection reason without inventing routing v2 fields', () => {
    const projected = projectAttributes(
      {
        'aio_proxy.provider.weight': 100,
        'aio_proxy.route.selection_reason': 'weight',
      },
      false,
    );
    expect(projected.columns).toEqual({
      providerWeight: 100,
      selectionReason: 'weight',
    });
    expect(mergeAttributes(projected.columns, projected.remaining, false)).toEqual({
      'aio_proxy.provider.weight': 100,
      'aio_proxy.route.selection_reason': 'weight',
    });
  });

  test('stores only long-tail attributes in attributes_json and reconstructs controlled attributes on read', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot({
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        requestId: 'request-a',
        inboundProtocol: 'openai-compatible',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: STARTED_AT,
        statusCode: 0,
        attributes: {
          'aio_proxy.request.id': 'request-a',
          'aio_proxy.protocol.inbound': 'openai-compatible',
          'aio_proxy.operation': 'model',
          'long.tail.custom': 'keep-me',
        },
        events: [],
        links: [],
      });

      store.complete({
        traceId: TRACE_ID,
        rootSpanId: ROOT_SPAN_ID,
        spans: [
          {
            traceId: TRACE_ID,
            spanId: ROOT_SPAN_ID,
            name: 'aio_proxy.request',
            kind: 1,
            startedAt: STARTED_AT,
            endedAt: ENDED_AT,
            statusCode: 0,
            attributes: {
              'aio_proxy.request.id': 'request-a',
              'aio_proxy.protocol.inbound': 'openai-compatible',
              'aio_proxy.operation': 'model',
              'gen_ai.request.model': 'requested-model',
              'gen_ai.response.model': 'final-model',
              'gen_ai.usage.input_tokens': 12,
              'gen_ai.usage.output_tokens': 7,
              'aio_proxy.route.final_provider_id': 'provider-x',
              'long.tail.custom': 'keep-me',
            },
            events: [],
            links: [],
          },
          {
            traceId: TRACE_ID,
            spanId: ATTEMPT_SPAN_ID,
            parentSpanId: ROOT_SPAN_ID,
            name: 'aio_proxy.provider.attempt',
            kind: 2,
            startedAt: STARTED_AT,
            endedAt: ENDED_AT,
            statusCode: 0,
            attributes: {
              'aio_proxy.attempt.index': 0,
              'aio_proxy.provider.id': 'provider-x',
              'aio_proxy.provider.weight': 100,
              'aio_proxy.route.selection_reason': 'weight',
              'aio_proxy.route.contract_version': 2,
              'aio_proxy.route.effective_priority': 30,
              'aio_proxy.route.effective_weight': 6000,
              'aio_proxy.route.priority_source': 'model',
              'aio_proxy.route.weight_source': 'provider',
              'aio_proxy.route.selection_source': 'deterministic_session',
              'gen_ai.request.model': 'final-model',
              'aio_proxy.transport': 'raw',
              'long.tail.attempt': 'also-kept',
            },
            events: [],
            links: [],
          },
        ],
        summary: {
          finalProviderId: 'provider-x',
          finalModelId: 'final-model',
          finalHttpStatus: 200,
          usage: { providerId: 'provider-x', modelId: 'final-model', inputTokens: 12, outputTokens: 7 },
        },
      });

      const rows = handle.db.select().from(traceSpan).all();
      const rootRow = rows.find((row) => row.parentSpanId === null)!;
      expect(rootRow.attributes).toEqual({ 'aio_proxy.operation': 'model', 'long.tail.custom': 'keep-me' });

      const detail = store.find(TRACE_ID)!;
      const rootAttrs = detail.spans.find((span) => span.spanId === ROOT_SPAN_ID)!.attributes;
      expect(rootAttrs['aio_proxy.request.id']).toBe('request-a');
      expect(rootAttrs['aio_proxy.protocol.inbound']).toBe('openai-compatible');
      expect(rootAttrs['aio_proxy.operation']).toBe('model');
      // root 发射的 gen_ai.* 仍然入列（requestedModelId 靠它兼容旧数据），但读回时
      // 不再挂回属性上：root 是纯 HTTP span，带着它们就成了第二个 GENERATION。
      expect(Object.keys(rootAttrs).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
      expect(rootRow.requestedModelId).toBe('requested-model');
      expect(rootAttrs['aio_proxy.route.final_provider_id']).toBe('provider-x');
      expect(rootAttrs['long.tail.custom']).toBe('keep-me');

      const attemptRow = rows.find((row) => row.spanId === ATTEMPT_SPAN_ID)!;
      expect(attemptRow.attributes).toEqual({
        'aio_proxy.route.contract_version': 2,
        'aio_proxy.route.effective_priority': 30,
        'aio_proxy.route.effective_weight': 6000,
        'aio_proxy.route.priority_source': 'model',
        'aio_proxy.route.weight_source': 'provider',
        'aio_proxy.route.selection_source': 'deterministic_session',
        // 非 root 的 gen_ai.request.model 是 GenAI span 自己的属性，原样留在 JSON 里。
        'gen_ai.request.model': 'final-model',
        'long.tail.attempt': 'also-kept',
      });
      expect(attemptRow.providerWeight).toBe(100);
      expect(attemptRow.selectionReason).toBe('weight');
      expect(attemptRow).not.toHaveProperty('routingContractVersion');
      expect(attemptRow).not.toHaveProperty('effectivePriority');
      expect(attemptRow).not.toHaveProperty('effectiveWeight');
      expect(attemptRow).not.toHaveProperty('prioritySource');
      expect(attemptRow).not.toHaveProperty('weightSource');
      expect(attemptRow).not.toHaveProperty('selectionSource');

      const attemptAttrs = detail.spans.find((span) => span.spanId === ATTEMPT_SPAN_ID)!.attributes;
      expect(attemptAttrs['aio_proxy.attempt.index']).toBe(0);
      expect(attemptAttrs['aio_proxy.provider.id']).toBe('provider-x');
      expect(attemptAttrs['aio_proxy.provider.weight']).toBe(100);
      expect(attemptAttrs['aio_proxy.route.selection_reason']).toBe('weight');
      expect(attemptAttrs['aio_proxy.route.contract_version']).toBe(2);
      expect(attemptAttrs['aio_proxy.route.effective_priority']).toBe(30);
      expect(attemptAttrs['aio_proxy.route.effective_weight']).toBe(6000);
      expect(attemptAttrs['aio_proxy.route.priority_source']).toBe('model');
      expect(attemptAttrs['aio_proxy.route.weight_source']).toBe('provider');
      expect(attemptAttrs['aio_proxy.route.selection_source']).toBe('deterministic_session');
      expect(attemptAttrs['gen_ai.request.model']).toBe('final-model');
      expect(attemptAttrs['aio_proxy.transport']).toBe('raw');
      expect(attemptAttrs['long.tail.attempt']).toBe('also-kept');
    } finally {
      handle.close();
    }
  });
});
