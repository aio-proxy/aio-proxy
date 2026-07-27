import { describe, expect, test } from 'bun:test';

import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording } from '../../../__tests__/pipeline-helpers';
import { attemptsOf, pipeline } from './test-support';

describe('shared protocol routing pipeline raw exception logging', () => {
  test('falls back after a raw network throw', async () => {
    const cause = Object.assign(new Error('cause-message-sentinel'), { code: 'ECONNREFUSED' });
    const failure = Object.assign(new Error('exception-message-sentinel'), {
      code: 'ConnectionRefused',
      cause,
      errno: -61,
      syscall: 'connect',
    });
    const primary = rawProvider({
      id: 'primary',
      invoke: async () => {
        throw failure;
      },
    });
    const backup = rawProvider({ id: 'backup' });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ provider: 'backup' });
    await settleRecording(harness.recording);
    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: 'failure', providerId: 'primary', statusCode: 502 },
      { outcome: 'success', providerId: 'backup', statusCode: 200 },
    ]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: 'request.provider_attempt_failed',
        attemptIndex: 0,
        providerId: 'primary',
        statusCode: 502,
        failureKind: 'exception',
        fallback: true,
        errorType: 'Error',
        exceptionCode: 'ConnectionRefused',
        causeCode: 'ECONNREFUSED',
        errno: -61,
        syscall: 'connect',
      }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain('exception-message-sentinel');
    expect(JSON.stringify(harness.logs)).not.toContain('cause-message-sentinel');
  });

  test('safe exception logging never invokes code accessors', async () => {
    let getterCalls = 0;
    const failure = new Error('exception-message-sentinel');
    Object.defineProperty(failure, 'code', {
      get() {
        getterCalls += 1;
        return 'accessor-code-sentinel';
      },
    });
    const primary = rawProvider({
      id: 'primary',
      invoke: async () => {
        throw failure;
      },
    });
    const harness = pipeline([primary, rawProvider({ id: 'backup' })]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ provider: 'backup' });
    await settleRecording(harness.recording);
    expect(getterCalls).toBe(0);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: 'request.provider_attempt_failed',
        attemptIndex: 0,
        providerId: 'primary',
        failureKind: 'exception',
      }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain('exception-message-sentinel');
    expect(JSON.stringify(harness.logs)).not.toContain('accessor-code-sentinel');
  });
});
