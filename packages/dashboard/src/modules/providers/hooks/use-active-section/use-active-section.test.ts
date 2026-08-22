import { afterEach, expect, test } from '@rstest/core';
import { act, renderHook } from '@testing-library/react';

import { useActiveSection } from './use-active-section';

type ObserverCallback = (entries: readonly IntersectionObserverEntry[]) => void;

const entry = (id: string, isIntersecting: boolean) =>
  ({ target: { id }, isIntersecting }) as unknown as IntersectionObserverEntry;

const observed: { callback?: ObserverCallback } = {};
const original = globalThis.IntersectionObserver;

class FakeIntersectionObserver {
  constructor(callback: ObserverCallback) {
    observed.callback = callback;
  }
  observe() {}
  disconnect() {}
}

afterEach(() => {
  observed.callback = undefined;
  globalThis.IntersectionObserver = original;
});

/**
 * The observer reports only the sections whose visibility *changed*, so a section entering the viewport
 * arrives alone in its own batch. Reading the active section out of that batch handed the pill to the
 * newcomer even with an earlier section still on screen, which is what a "which section am I in" strip
 * exists to name.
 */
test('keeps the earliest visible section active when a later one arrives in its own batch', () => {
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  const { result } = renderHook(() => useActiveSection());
  const report = (...entries: readonly IntersectionObserverEntry[]) =>
    act(() => {
      observed.callback?.(entries);
    });

  report(entry('models', true));
  expect(result.current).toBe('models');

  // `advanced` alone in a batch, while `models` — reported visible earlier and never reported gone — is
  // still on screen. Document order decides, not arrival order.
  report(entry('advanced', true));
  expect(result.current).toBe('models');

  report(entry('models', false));
  expect(result.current).toBe('advanced');
});
