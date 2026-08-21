import type { AgentAccessAuthentication, AgentAccessGrant } from '@aio-proxy/core';
import { AGENT_ACCESS_TOKEN_PREFIX, hasReservedAgentTokenPrefix } from '@aio-proxy/types';
import type { MiddlewareHandler } from 'hono';

import {
  authenticateStaticOrAnonymous,
  authenticationError,
  bearerToken,
  stripCallerCredentials,
} from '../api-key-auth/api-key-auth';

export type AgentEnv = {
  Variables: {
    agentGrant?: AgentAccessGrant;
  };
};

export type ModelAuthenticationDeps = {
  readonly apiKeys: () => readonly { readonly key: string }[];
  readonly authenticateAgent: (token: string) => AgentAccessAuthentication;
};

export const requireModelAuthentication =
  (deps: ModelAuthenticationDeps): MiddlewareHandler<AgentEnv> =>
  async (context, next) => {
    const bearer = bearerToken(context.req.header('authorization'));
    if (bearer !== undefined && hasReservedAgentTokenPrefix(bearer)) {
      if (!bearer.startsWith(AGENT_ACCESS_TOKEN_PREFIX)) return authenticationError(context);
      const result = deps.authenticateAgent(bearer);
      if (result.status !== 'valid') return authenticationError(context);
      context.set('agentGrant', result.grant);
      stripCallerCredentials(context);
      await next();
      return;
    }
    return authenticateStaticOrAnonymous(context, next, deps.apiKeys());
  };
