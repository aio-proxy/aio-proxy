import confetti from 'canvas-confetti';

/**
 * A burst from the control that was activated, rather than from the middle of the page. What earns one
 * here happens inside a modal, so a celebration anywhere else reads as belonging to something other than
 * the click that caused it. Falls back to the viewport centre when the control is already gone.
 */
export const celebrate = (origin?: Element | null) => {
  const rect = origin?.getBoundingClientRect();
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
    origin:
      rect === undefined
        ? { x: 0.5, y: 0.5 }
        : {
            x: (rect.left + rect.width / 2) / window.innerWidth,
            y: (rect.top + rect.height / 2) / window.innerHeight,
          },
  });
};
