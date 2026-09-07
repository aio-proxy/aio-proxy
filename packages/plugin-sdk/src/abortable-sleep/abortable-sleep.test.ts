import { expect, spyOn, test } from 'bun:test';

import { abortableSleep } from './abortable-sleep';

test('preserves cancellation reasons before and during sleep', async () => {
  const controller = new AbortController();
  const reason = new Error('login deadline');
  const sleeping = abortableSleep(60_000, controller.signal);
  controller.abort(reason);
  await expect(sleeping).rejects.toBe(reason);
  await expect(abortableSleep(60_000, controller.signal)).rejects.toBe(reason);
});

test('removes the same abort listener on completion and cancellation', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const added = spyOn(controller.signal, 'addEventListener');
    const removed = spyOn(controller.signal, 'removeEventListener');
    try {
      const sleeping = abortableSleep(cancel ? 60_000 : 1, controller.signal);
      if (cancel) {
        controller.abort(new Error('cancelled'));
        await expect(sleeping).rejects.toBe(controller.signal.reason);
      } else await sleeping;
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]![1]);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  }
});
