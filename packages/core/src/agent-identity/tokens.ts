import { createHash, randomBytes } from 'node:crypto';

import { AGENT_ACCESS_TOKEN_PREFIX, AGENT_REFRESH_TOKEN_PREFIX } from '@aio-proxy/types';

export const hashAgentToken = (token: string): string => createHash('sha256').update(token).digest('base64url');

export const createAgentToken = (kind: 'access' | 'refresh', random: (size: number) => Buffer = randomBytes): string =>
  `${kind === 'access' ? AGENT_ACCESS_TOKEN_PREFIX : AGENT_REFRESH_TOKEN_PREFIX}${random(32).toString('base64url')}`;
