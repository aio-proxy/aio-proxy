import { ProviderProtocol } from '@aio-proxy/types';

import { defineEvaluationProtocolAdapter, type EvaluationQuestion } from '../adapter';
import { systemOneJson } from './egress';
import { systemOneErrors } from './errors';
import { parseSystemOneBody, type SystemOneRequest } from './parse';

export type SystemOneContext = Readonly<Record<never, never>>;

// Convert projects the SDK question envelope; it never rewrites evaluation data.
// `noul.criteria` must carry only `true`/`false`: ai@7.0.107 rejects any other key
// on a boolean question, and the parser deliberately preserves unknown keys for
// raw passthrough, so the declared type is not a runtime guarantee here.
// Absence is preserved rather than materialized as an explicit `undefined`, which
// would fail the SDK's own `isJSON(criteria)` check.
const projectQuestion = (question: EvaluationQuestion): EvaluationQuestion => {
  if (question.type !== 'noul' || question.criteria === undefined) return question;
  const { true: yes, false: no } = question.criteria;
  const criteria = {
    ...(yes === undefined ? {} : { true: yes }),
    ...(no === undefined ? {} : { false: no }),
  };
  return {
    type: 'noul',
    instructions: question.instructions,
    ...(Object.keys(criteria).length === 0 ? {} : { criteria }),
  };
};

export const typeSafeSystemOneAdapter = defineEvaluationProtocolAdapter<SystemOneRequest, SystemOneContext>({
  protocol: ProviderProtocol.TypeSafeSystemOne,
  parse: (raw) => parseSystemOneBody(raw),
  model: (request) => request.model,
  rawRequest: (raw, request, resolvedModel) =>
    Promise.resolve(
      new Request(raw.url, {
        method: raw.method,
        headers: raw.headers,
        // Forward the original body with only `model` rewritten, preserving unknown fields.
        body: JSON.stringify({ ...request.body, model: resolvedModel }),
      }),
    ),
  evaluationInvocation: (request) => ({
    state: request.state,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, projectQuestion(question)]),
    ),
  }),
  evaluationJson: systemOneJson,
  errors: systemOneErrors,
});
