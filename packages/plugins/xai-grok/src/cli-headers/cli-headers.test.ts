import { describe, expect, test } from 'bun:test';

import { createXAIGrokCLIHeaders, XAI_GROK_CLI_CLIENT_VERSION } from './cli-headers';

describe('xAI Grok CLI headers', () => {
  test('sends the current CPA identity set', () => {
    const headers = createXAIGrokCLIHeaders({
      accessToken: 'access-token',
      refreshToken: 'refresh',
      expiresAt: 1,
    });
    expect(XAI_GROK_CLI_CLIENT_VERSION).toBe('0.2.120');
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
    expect(headers.get('x-grok-client-version')).toBe('0.2.120');
    expect(headers.get('x-grok-client-identifier')).toBe('grok-shell');
    expect(headers.get('x-authenticateresponse')).toBe('authenticate-response');
    expect(headers.get('user-agent')).toBe('xai-grok-workspace/0.2.120');
  });
});
