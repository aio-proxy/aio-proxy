import { expect, test } from 'bun:test';

import { claudeClientId } from './rslib.config';

test('build embeds the Claude OAuth client ID without leaving source plaintext', async () => {
  const [source, config, setup, artifact] = await Promise.all([
    Bun.file('./src/oauth/constants.ts').text(),
    Bun.file('./rslib.config.ts').text(),
    Bun.file('./test/setup.ts').text(),
    Bun.file('./dist/oauth/constants.js').text(),
  ]);
  const encodedClientId = btoa(claudeClientId);

  expect(new Bun.CryptoHasher('sha256').update(claudeClientId).digest('hex')).toBe(
    '473668f2b13c71009d028ff0ef74c2cf76e71cbdd33b76e69fcc42d7e59aca4b',
  );
  for (const text of [source, config, setup]) {
    expect(text.includes(claudeClientId)).toBe(false);
    expect(text.includes(encodedClientId)).toBe(false);
  }
  expect(artifact.includes(claudeClientId)).toBe(true);
  expect(artifact.includes('__AIO_PROXY_CLAUDE_CLIENT_ID__')).toBe(false);
  expect(/\batob\s*\(/u.test(artifact)).toBe(false);
});
