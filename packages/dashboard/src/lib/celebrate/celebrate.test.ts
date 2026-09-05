import { expect, rs, test } from '@rstest/core';

import { celebrate } from './celebrate';

const mocks = rs.hoisted(() => ({ confetti: rs.fn() }));

rs.mock('canvas-confetti', () => ({ default: mocks.confetti }));

/**
 * The celebration exists to be seen by someone who just clicked something, and what they clicked is
 * usually inside a modal. A burst from the middle of the viewport would read as belonging to the page
 * rather than to their click, so the origin has to be derived from the control.
 */
test('bursts from the control that was activated', () => {
  mocks.confetti.mockReset();
  const control = document.createElement('button');
  control.getBoundingClientRect = () => ({ left: 200, top: 400, width: 100, height: 40 }) as DOMRect;
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

  celebrate(control);

  expect(mocks.confetti.mock.calls[0]?.[0]).toMatchObject({ origin: { x: 0.25, y: 0.525 } });
});

/**
 * Fired from a `onSuccess` that runs after the refetch it triggered, so by then the control may already
 * be gone — spending the last credit unmounts it. Celebrating the viewport beats crashing on a null rect.
 */
test('falls back to the viewport when the control is already gone', () => {
  mocks.confetti.mockReset();

  celebrate(null);

  expect(mocks.confetti.mock.calls[0]?.[0]).toMatchObject({ origin: { x: 0.5, y: 0.5 } });
});

// Decoration layered on feedback that already reads on its own, so it is dropped rather than degraded
// for anyone who asked the platform for less motion.
test('respects a reduced-motion preference', () => {
  mocks.confetti.mockReset();

  celebrate(null);

  expect(mocks.confetti.mock.calls[0]?.[0]).toMatchObject({ disableForReducedMotion: true });
});
