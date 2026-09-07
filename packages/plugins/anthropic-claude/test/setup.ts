import { claudeClientId } from '../rslib.config';

const fingerprint = new Bun.CryptoHasher('sha256').update(claudeClientId).digest('hex');
if (fingerprint !== '473668f2b13c71009d028ff0ef74c2cf76e71cbdd33b76e69fcc42d7e59aca4b') {
  throw new Error('Claude OAuth client ID fingerprint mismatch');
}

Object.assign(globalThis, {
  __AIO_PROXY_CLAUDE_CLIENT_ID__: claudeClientId,
});
