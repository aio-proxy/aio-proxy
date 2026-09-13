import { expect, test } from 'bun:test';

import { formatAgentToken } from './token-output';

test('formats command auth tokens for raw and JSON stdout contracts', () => {
  const token = { accessToken: 'aio_agent_at_v1_token', expiresIn: 900 };
  expect(formatAgentToken(token, 'raw')).toBe('aio_agent_at_v1_token\n');
  expect(formatAgentToken(token, 'json')).toBe('{"access_token":"aio_agent_at_v1_token","expires_in":900}\n');
});
