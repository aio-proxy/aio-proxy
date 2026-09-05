import confetti from 'canvas-confetti';

/** Viewport-relative, in the 0..1 space `canvas-confetti` fires from. */
export interface CelebrationOrigin {
  readonly x: number;
  readonly y: number;
}

/**
 * Where a control sits, resolved while it is still on screen. Deliberately not the element: the control
 * that earns a celebration is usually unmounted by the outcome that earns it, and a detached node
 * measures as a zero rect at the viewport corner — a burst nowhere near the click.
 */
export const celebrationOriginOf = (control: Element): CelebrationOrigin => {
  const rect = control.getBoundingClientRect();
  return {
    x: (rect.left + rect.width / 2) / window.innerWidth,
    y: (rect.top + rect.height / 2) / window.innerHeight,
  };
};

/**
 * A burst from the point the user acted on, rather than from the middle of the page. What earns one
 * here happens inside a modal, so a celebration anywhere else reads as belonging to something other
 * than the click that caused it.
 */
export const celebrate = (origin: CelebrationOrigin) => {
  void confetti({
    particleCount: 80,
    spread: 70,
    startVelocity: 32,
    // Above the `z-50` dialog layer it is usually fired from and the `z-100` toast viewport it
    // accompanies, so the burst is never clipped behind the frame that prompted it.
    zIndex: 200,
    // Decoration on top of feedback that already reads on its own, so the whole effect is dropped rather
    // than degraded when motion is unwelcome.
    disableForReducedMotion: true,
    origin,
  });
};
