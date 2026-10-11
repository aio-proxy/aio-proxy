import { expect, test } from 'bun:test';

import { createBodyCapture } from '.';

const bytes = new TextEncoder().encode('ab🙂cd');

test('a split UTF-8 character stays intact inside the capture budget', () => {
  const capture = createBodyCapture(6);
  const text = capture.write(bytes.subarray(0, 4)) + capture.write(bytes.subarray(4)) + capture.finish();
  expect(text).toBe('ab🙂');
  expect(capture.capturedBytes).toBe(6);
  expect(capture.truncated).toBeTrue();
  expect(capture.finish()).toBe('');
});

test('omits an incomplete character at a truncated boundary and ignores later chunks', () => {
  const capture = createBodyCapture(4);
  const text =
    capture.write(bytes.subarray(0, 3)) + capture.write(bytes.subarray(3)) + capture.write(bytes) + capture.finish();
  expect(text).toBe('ab');
  expect(capture.capturedBytes).toBe(4);
  expect(capture.truncated).toBeTrue();
});

test('zero capture does not retain body text and untruncated captures finish normally', () => {
  const disabled = createBodyCapture(0);
  expect(disabled.write(bytes) + disabled.finish()).toBe('');
  expect(disabled.capturedBytes).toBe(0);
  const full = createBodyCapture(bytes.byteLength);
  expect(full.write(bytes) + full.finish()).toBe('ab🙂cd');
  expect(full.truncated).toBeFalse();
});
