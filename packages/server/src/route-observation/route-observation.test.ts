import { describe, expect, test } from 'bun:test';

import { isAbortError } from './route-observation';

describe('isAbortError', () => {
  test('detects a direct AbortError', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBeTrue();
  });
  test('detects an AbortError nested in the cause chain', () => {
    const abort = new DOMException('aborted', 'AbortError');
    const wrapper: Error & { cause?: unknown } = new Error('wrapper');
    wrapper.cause = abort;
    expect(isAbortError(wrapper)).toBeTrue();
  });

  test('rejects non-abort errors and non-errors', () => {
    expect(isAbortError(new TypeError('boom'))).toBeFalse();
    expect(isAbortError('AbortError')).toBeFalse();
    expect(isAbortError(undefined)).toBeFalse();
  });

  test('stays false without throwing when a cause accessor throws', () => {
    const error = new Error('provider failure');
    Object.defineProperty(error, 'cause', {
      get() {
        throw new Error('cause accessor exploded');
      },
    });
    expect(() => isAbortError(error)).not.toThrow();
    expect(isAbortError(error)).toBeFalse();
  });

  test('terminates on a self-referential cause chain', () => {
    const error: Error & { cause?: unknown } = new Error('cyclic');
    error.cause = error;
    expect(isAbortError(error)).toBeFalse();
  });
});
