import { AgentCatalogQuerySchema } from '@aio-proxy/types';
import type { MiddlewareHandler } from 'hono';

import type { ServerState } from '../server-state';
import type { AgentEnv } from './agent-auth';
import { authenticationError } from './api-key-auth/api-key-auth';
import { agentCatalog, codexClientModels, listModels } from './list-models/index';

type AgentCatalogQuery = ReturnType<typeof AgentCatalogQuerySchema.parse>;
type ModelsEnv = {
  Variables: AgentEnv['Variables'] & {
    agentCatalogQuery: AgentCatalogQuery | null;
  };
};

const agentQueryFields = ['agent', 'adapter_version', 'schema_version'] as const;

export const parseAgentCatalogNegotiation: MiddlewareHandler<ModelsEnv> = async (context, next) => {
  const raw = Object.fromEntries(
    agentQueryFields.flatMap((field) => {
      const value = context.req.query(field);
      return value === undefined ? [] : ([[field, value]] as const);
    }),
  );
  if (Object.keys(raw).length === 0) {
    context.set('agentCatalogQuery', null);
    await next();
    return;
  }
  if (raw['schema_version'] !== undefined && raw['schema_version'] !== '1') {
    return context.json(
      {
        error: {
          code: 'unsupported_schema',
          message: `Agent catalog schema ${raw['schema_version']} is not supported.`,
        },
        supported_schema_versions: [1],
      },
      400,
    );
  }
  const parsed = AgentCatalogQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
  }
  context.set('agentCatalogQuery', parsed.data);
  await next();
};

export const listModelsHandler =
  (state: ServerState): MiddlewareHandler<ModelsEnv> =>
  async (context) => {
    const query = context.get('agentCatalogQuery');
    const grant = context.get('agentGrant');
    if (query !== null && query !== undefined) {
      if (grant === undefined) return authenticationError(context);
      if (grant.target !== query.agent) {
        return context.json({ error: { code: 'forbidden', message: 'Agent catalog target mismatch.' } }, 403);
      }
      return context.json(await agentCatalog(state, query.agent));
    }
    // Grok access tokens always receive the ordinary catalog, including client_version queries.
    if (grant?.target === 'grok') return context.json(await listModels(state));
    if (context.req.query('client_version') !== undefined) {
      if (grant !== undefined && grant.target !== 'codex') {
        return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
      }
      return context.json(await codexClientModels(state, { signal: context.req.raw.signal }));
    }
    if (grant !== undefined && grant.target !== 'codex') {
      return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
    }
    return context.json(await listModels(state));
  };
