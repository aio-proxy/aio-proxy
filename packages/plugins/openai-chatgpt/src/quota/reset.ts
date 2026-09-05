import type { AccountContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { CHATGPT_USER_AGENT, currentCredential } from '../runtime/index';
import type { ChatGPTCredential } from '../schema';
import { RESET_CREDITS_CONSUME_URL } from './endpoints';

/**
 * Redeems one rate-limit reset credit. The framework has already confirmed the inventory reports an
 * available credit, so a rejection here is an upstream failure, not a "nothing to redeem" answer.
 *
 * `redeem_request_id` is the upstream's idempotency key. A fresh one per call is deliberate: the
 * framework serializes resets per Provider and refuses to start one without an available credit, so a
 * second call is a second intentional redemption, not a retry of the first.
 */
export async function resetOpenAIChatGPTQuota(
  context: AccountContext<ChatGPTCredential, Record<string, never>>,
  fetcher: RuntimeFetch = context.fetch ?? globalThis.fetch,
): Promise<void> {
  const credential = await currentCredential(context.credentials, fetcher);
  const response = await fetcher(RESET_CREDITS_CONSUME_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-Id': credential.accountId,
      'Content-Type': 'application/json',
      'User-Agent': CHATGPT_USER_AGENT,
    },
    body: JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
    signal: context.signal,
    aioProxy: { traffic: 'control' },
  });
  if (!response.ok) {
    throw new Error(`ChatGPT reset-credit redemption failed with ${response.status}`);
  }
}
