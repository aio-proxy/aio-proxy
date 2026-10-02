import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

import { PromptCancelledError } from '../../ui';

export async function detectLocalSignIn(localSignIn: NonNullable<OAuthAdapter['localSignIn']>): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
      controller.abort();
    }, 2_000);
  });
  try {
    // Bound third-party probes even when they ignore cancellation.
    return await Promise.race([localSignIn.detect({ signal: controller.signal }), timeout]);
  } catch (error) {
    if (error instanceof PromptCancelledError || (error instanceof Error && error.name === 'AbortError')) throw error;
    return false;
  } finally {
    clearTimeout(timer);
  }
}
