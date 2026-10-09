import { ProviderProtocol } from '@aio-proxy/types';

import { defineEvaluationProtocolAdapter, type EmptyProtocolContext } from '../adapter';
import { rewriteJsonRequestModel } from '../request/index';
import { decisionsInvocation, decisionsJson } from './conversion';
import { openAIDecisionsErrors } from './errors';
import { parseOpenAIDecisions, type OpenAIDecisionsRequest } from './parse';

export const openAIDecisionsAdapter = defineEvaluationProtocolAdapter<OpenAIDecisionsRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.OpenAIDecisions,
  parse: parseOpenAIDecisions,
  model: (request) => request.model,
  async rawRequest(raw, _request, resolvedModel) {
    const rewritten = await rewriteJsonRequestModel(raw, resolvedModel);
    // Bun merges inherited headers when constructing from a Request, including
    // fields deleted from the replacement Headers. Remove them on the result.
    rewritten.headers.delete('content-encoding');
    rewritten.headers.delete('content-length');
    return rewritten;
  },
  evaluationInvocation: decisionsInvocation,
  evaluationJson: decisionsJson,
  errors: openAIDecisionsErrors,
});
