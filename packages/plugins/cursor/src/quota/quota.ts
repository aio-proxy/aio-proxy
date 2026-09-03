import type { AccountContext, OAuthQuotaSnapshot, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { currentCursorCredential, type CursorOAuthDependencies } from '../oauth/index';
import type { CursorCredential } from '../schema';
import { cursorSessionCookie } from './cookie';
import { readGrokBotItem } from './sand';
import { readUsageSummary, summaryQuota } from './summary';

export async function readCursorQuota(
  context: AccountContext<CursorCredential, Record<string, never>>,
  dependencies: CursorOAuthDependencies = {},
): Promise<OAuthQuotaSnapshot> {
  const fetcher: RuntimeFetch = dependencies.fetch ?? context.fetch ?? globalThis.fetch;
  // The cookie carries the access token, so an expired one is a 401 rather than a retry.
  const credential = await currentCursorCredential(context.credentials, {
    ...dependencies,
    fetch: fetcher,
    signal: context.signal,
  });
  const cookie = cursorSessionCookie(credential.accessToken, credential.subject);

  // `readGrokBotItem` never rejects, so this settles on the summary alone.
  const [summary, grokBot] = await Promise.all([
    readUsageSummary(fetcher, cookie, context.signal),
    readGrokBotItem(fetcher, cookie, context.signal),
  ]);
  context.signal.throwIfAborted();

  const { items, plan } = summaryQuota(summary);
  const allItems = grokBot === undefined ? items : [...items, grokBot];
  if (allItems.length === 0) throw new Error('Cursor usage summary contains no usable quota');
  return { items: allItems, ...(plan === undefined ? {} : { plan }) };
}
