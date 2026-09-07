import { expect, test } from 'bun:test';

import { create, fromBinary } from '@bufbuild/protobuf';

import { AgentClientMessageSchema, InteractionQuerySchema } from '../../gen/agent_pb';
import { encodeInteractionReply } from './interaction-query';

test.each([
  ['webSearchRequestQuery', 'webSearchRequestResponse', 'approved'],
  ['exaSearchRequestQuery', 'exaSearchRequestResponse', 'approved'],
  ['exaFetchRequestQuery', 'exaFetchRequestResponse', 'approved'],
  ['webFetchRequestQuery', 'webFetchRequestResponse', 'approved'],
  ['askQuestionInteractionQuery', 'askQuestionInteractionResponse', 'rejected'],
  ['switchModeRequestQuery', 'switchModeRequestResponse', 'rejected'],
  ['createPlanRequestQuery', 'createPlanRequestResponse', 'error'],
] as const)('%s sends an explicit %s %s reply', (queryCase, responseCase, outcome) => {
  const query = create(InteractionQuerySchema, { id: 41, query: { case: queryCase, value: {} } } as never);
  const decoded = fromBinary(AgentClientMessageSchema, encodeInteractionReply(query).subarray(5));
  expect(decoded.message.case).toBe('interactionResponse');
  if (decoded.message.case !== 'interactionResponse') throw new Error('expected interaction response');
  const response = decoded.message.value;
  expect(response.id).toBe(41);
  expect(response.result.case).toBe(responseCase);
  const value = response.result.value as { result?: { case?: string; result?: { case?: string } } };
  const nested = value.result;
  expect(nested?.case ?? nested?.result?.case).toBe(outcome);
  expect(JSON.stringify(response)).not.toContain('"case":"success"');
});

test.each(['setupVmEnvironmentArgs', undefined] as const)('fails unsupported query %s', (queryCase) => {
  const query = create(InteractionQuerySchema, {
    id: 9,
    ...(queryCase === undefined ? {} : { query: { case: queryCase, value: {} } }),
  } as never);
  expect(() => encodeInteractionReply(query)).toThrow(
    expect.objectContaining({
      code: 'cursor_interaction_unsupported',
    }),
  );
});
