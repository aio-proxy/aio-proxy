import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

const decode = (...parts: string[]) => atob(parts.join(''));
export const claudeClientId = decode('OWQxYzI1MGEtZTYxYi00NGQ5', 'LTg4ZWQtNTk0NGQxOTYyZjVl');

export default defineLibraryConfig({
  source: { define: { __AIO_PROXY_CLAUDE_CLIENT_ID__: JSON.stringify(claudeClientId) } },
});
