import { describe, expect, test } from 'bun:test';

import { createXAIGrokCLIHeaders, XAI_GROK_CLI_CLIENT_VERSION } from './cli-headers';

describe('xAI Grok CLI headers', () => {
  test('sends the current CPA identity set', () => {
    const headers = createXAIGrokCLIHeaders({
      accessToken: 'access-token',
      refreshToken: 'refresh',
      expiresAt: 1,
    });
    expect(XAI_GROK_CLI_CLIENT_VERSION).toBe('1.0.50');
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
    expect(headers.get('x-grok-client-version')).toBe('1.0.50');
    expect(headers.get('x-grok-client-identifier')).toBe('grok-shell');
    expect(headers.get('x-grok-client-mode')).toBe('headless');
    expect(headers.get('x-authenticateresponse')).toBe('authenticate-response');
    expect(headers.get('user-agent')).toBe('grok-shell/1.0.50');
  });
});
