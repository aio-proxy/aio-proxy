import { CursorProtocolError } from '../protocol-error';

type FinishReason = 'tool-handoff' | 'turn-ended' | 'connect-end';
type Limits = {
  firstFrameTimeoutMs: number;
  frameSilenceTimeoutMs: number;
  noProgressTimeoutMs: number;
  turnEndGraceMs: number;
};
type Hooks = {
  limits: Limits;
  onFinish(reason: FinishReason): void;
  onFailure(error: unknown): void;
  cleanup(error?: unknown): void;
};

export function createRunLifecycle(hooks: Hooks) {
  const startedAt = Date.now();
  let lastInbound = startedAt;
  let lastProgress = startedAt;
  let frameCount = 0;
  let terminal = false;
  let ending = false;
  let first: ReturnType<typeof setTimeout> | undefined;
  let health: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    clearTimeout(first);
    clearTimeout(health);
    clearTimeout(grace);
    first = health = grace = undefined;
  };
  const settle = (reason?: FinishReason, error?: unknown) => {
    if (terminal) return;
    terminal = true;
    clear();
    let failure = error;
    try {
      if (reason === undefined) hooks.onFailure(error);
      else hooks.onFinish(reason);
    } catch (caught) {
      failure = caught;
      hooks.onFailure(caught);
    } finally {
      hooks.cleanup(failure);
    }
  };
  const armHealth = () => {
    clearTimeout(health);
    if (terminal || ending) return;
    const silenceDeadline = lastInbound + hooks.limits.frameSilenceTimeoutMs;
    const progressDeadline = lastProgress + hooks.limits.noProgressTimeoutMs;
    const deadline = Math.min(silenceDeadline, progressDeadline);
    health = setTimeout(
      () => {
        const now = Date.now();
        if (now < deadline) {
          armHealth();
          return;
        }
        const silent = now >= lastInbound + hooks.limits.frameSilenceTimeoutMs;
        settle(
          undefined,
          new CursorProtocolError(
            silent ? 'cursor_frame_silence_timeout' : 'cursor_no_progress_timeout',
            silent ? 'Cursor sent no inbound frames before completion.' : 'Cursor made no progress before completion.',
          ),
        );
      },
      Math.max(0, deadline - Date.now()),
    );
  };
  first = setTimeout(
    () =>
      settle(undefined, new CursorProtocolError('cursor_first_frame_timeout', 'Cursor did not send its first frame.')),
    hooks.limits.firstFrameTimeoutMs,
  );

  return {
    noteFrame(progress: boolean) {
      if (terminal) return;
      const now = Date.now();
      lastInbound = now;
      if (frameCount++ === 0) {
        lastProgress = now;
        clearTimeout(first);
        first = undefined;
      }
      if (progress) lastProgress = now;
      armHealth();
    },
    turnEnded() {
      if (terminal || ending) return;
      ending = true;
      clearTimeout(first);
      clearTimeout(health);
      first = health = undefined;
      grace = setTimeout(() => settle('turn-ended'), hooks.limits.turnEndGraceMs);
    },
    finish: (reason: FinishReason) => settle(reason),
    fail: (error: unknown) => settle(undefined, error),
    settled: () => terminal,
    snapshot: () => ({
      elapsedMs: Date.now() - startedAt,
      frameCount,
      lastInboundAgeMs: Date.now() - lastInbound,
      lastProgressAgeMs: Date.now() - lastProgress,
    }),
  };
}
