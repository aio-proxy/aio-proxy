import type { AgentAccessAuthentication, AgentAccessGrant } from '@aio-proxy/core';
import { AGENT_ACCESS_TOKEN_PREFIX, hasReservedAgentTokenPrefix } from '@aio-proxy/types';
import type { MiddlewareHandler } from 'hono';

import { agentCallerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import {
  authenticateStaticOrAnonymous,
  authenticationError,
  bearerToken,
  stripCallerCredentials,
} from '../api-key-auth/api-key-auth';

// Composed rather than redeclared: an independent `callerPrincipal` declaration would keep
// typechecking after the variable key is renamed on one side only, while `callerPrincipal()`
// silently reads a key nothing writes.
export type AgentEnv = {
  Variables: CallerPrincipalEnv['Variables'] & {
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
      context.set('callerPrincipal', agentCallerPrincipal(result.grant.installationId));
      stripCallerCredentials(context);
      await next();
      return;
    }
    return authenticateStaticOrAnonymous(context, next, deps.apiKeys());
  };
