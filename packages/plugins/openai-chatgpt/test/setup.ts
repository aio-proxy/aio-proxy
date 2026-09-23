import { beforeEach } from 'bun:test';

import { openAIChatGPTClientId } from '../rslib.config';
import { CODEX_CLIENT_VERSION } from '../src/codex-client';
import { latestCodexRsVersion, resetLatestCodexRsVersionCache } from '../src/plugin-options/codex-version';

const fingerprint = new Bun.CryptoHasher('sha256').update(openAIChatGPTClientId).digest('hex');
if (fingerprint !== '584341c2f0e88ad1f7c6856553d81dc4776ff42c43951daed3e2d8d91552eaa2') {
  throw new Error('OpenAI ChatGPT OAuth credential fingerprint mismatch');
}

Object.assign(globalThis, {
  __AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__: openAIChatGPTClientId,
});

// Most transport tests exercise ChatGPT itself. Prime discovery through its
// network boundary; discovery regression tests explicitly clear this cache.
beforeEach(async () => {
  resetLatestCodexRsVersionCache();
  await latestCodexRsVersion(
    Object.assign(
      async () =>
        Response.json({
          tag_name: `rust-v${CODEX_CLIENT_VERSION}`,
          name: '@openai/codex',
          version: CODEX_CLIENT_VERSION,
        }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
});
