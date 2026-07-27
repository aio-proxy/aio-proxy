import { describe, expect, test } from 'bun:test';

import {
  defineProtocolAdapter,
  errorStream,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  settleRecording,
  textStream,
  textThenErrorStream,
} from '../../../__tests__/pipeline-helpers';
import { attemptsOf, pipeline } from './test-support';

describe('shared protocol routing pipeline model commit fallback', () => {
  test.each(['ensure', 'invoke', 'first-event', 'json'] as const)(
    'falls back when model %s fails before the response is committed',
    async (stage) => {
      const error = new Error(`${stage} failed`);
      const primary = modelProvider({
        id: 'primary',
        ...(stage === 'ensure'
          ? {
              ensureAvailable: async () => {
                throw error;
              },
            }
          : {}),
        invoke: () => {
          if (stage === 'invoke') throw error;
          if (stage === 'first-event') return errorStream(error);
          if (stage === 'json') return textThenErrorStream('partial', error);
          return textStream('unused');
        },
      });
      const backup = modelProvider({ id: 'backup', invoke: () => textStream('fallback') });
      const harness = pipeline([primary, backup]);
      const stream = stage === 'first-event';

      const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream }));
      if (stream) {
        expect(await response.text()).toContain('fallback');
      } else {
        expect(await response.json()).toEqual({ output: 'fallback' });
      }
      await settleRecording(harness.recording);
      expect(primary.calls.model).toHaveLength(stage === 'ensure' ? 0 : 1);
      expect(backup.calls.model).toHaveLength(1);
      expect(harness.context.modelInvocationCalls).toBe(1);
      expect(attemptsOf(harness.recording)).toEqual([
        { outcome: 'failure', providerId: 'primary', statusCode: 502 },
        { outcome: 'success', providerId: 'backup', statusCode: undefined },
      ]);
      if (stage === 'first-event') {
        expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
      }
    },
  );

  test('does not let immediate completion win when the SSE writer throws before commit', async () => {
    const writerError = new Error('writer failed');
    const base = defineProtocolAdapter();
    let writerCalls = 0;
    const adapter = {
      ...base,
      modelSse(stream: Parameters<typeof base.modelSse>[0]) {
        writerCalls += 1;
        if (writerCalls === 1) throw writerError;
        return base.modelSse(stream);
      },
    } satisfies typeof base;
    const primary = modelProvider({ id: 'primary', invoke: () => textStream('primary') });
    const backup = modelProvider({ id: 'backup', invoke: () => textStream('backup') });
    const harness = pipeline([primary, backup], {
      adapter,
      immediateStreamCompletion: { outcome: 'success' },
    });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    expect(await response.text()).toContain('backup');
    await settleRecording(harness.recording);

    expect(writerCalls).toBe(2);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: 'failure', providerId: 'primary', statusCode: 502 },
      { outcome: 'success', providerId: 'backup', statusCode: undefined },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: 'backup', outcome: 'success' }),
    );
    expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
  });

  test('does not let immediate completion win when JSON serialization throws before commit', async () => {
    const base = defineProtocolAdapter();
    let jsonCalls = 0;
    const adapter = {
      ...base,
      async modelJson(stream: Parameters<typeof base.modelJson>[0]) {
        jsonCalls += 1;
        if (jsonCalls === 1) return { value: 1n };
        return base.modelJson(stream);
      },
    } satisfies typeof base;
    const primary = modelProvider({ id: 'primary', invoke: () => textStream('primary') });
    const backup = modelProvider({ id: 'backup', invoke: () => textStream('backup') });
    const harness = pipeline([primary, backup], {
      adapter,
      immediateStreamCompletion: { outcome: 'success' },
    });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ output: 'backup' });
    await settleRecording(harness.recording);

    expect(jsonCalls).toBe(2);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: 'failure', providerId: 'primary', statusCode: 502 },
      { outcome: 'success', providerId: 'backup', statusCode: undefined },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: 'backup', outcome: 'success' }),
    );
  });
});
