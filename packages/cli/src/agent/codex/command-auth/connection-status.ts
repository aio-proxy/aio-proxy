import { AgentRuntimeError } from '@aio-proxy/agent-provider-runtime';

export const connectionFromError = (error: unknown): 'offline' | 'unauthorized' | 'invalid_response' =>
  error instanceof AgentRuntimeError
    ? error.code === 'network'
      ? 'offline'
      : error.code === 'invalid_grant' || error.code === 'invalid_client'
        ? 'unauthorized'
        : 'invalid_response'
    : 'offline';
