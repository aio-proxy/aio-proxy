import { create, toBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  type InteractionQuery,
  type InteractionResponse,
  InteractionResponseSchema,
} from '../../gen/agent_pb';
import { frameConnectMessage } from '../../wire/frame';
import { CursorProtocolError } from '../protocol-error';

const NON_INTERACTIVE = 'This proxy cannot perform this client interaction.';
const NO_FILES = 'This proxy cannot create plan files.';

export function encodeInteractionReply(query: InteractionQuery): Uint8Array {
  const id = query.id;
  switch (query.query.case) {
    case 'webSearchRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'webSearchRequestResponse',
            value: { result: { case: 'approved', value: {} } },
          },
        }),
      );
    case 'exaSearchRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'exaSearchRequestResponse',
            value: { result: { case: 'approved', value: {} } },
          },
        }),
      );
    case 'exaFetchRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'exaFetchRequestResponse',
            value: { result: { case: 'approved', value: {} } },
          },
        }),
      );
    case 'webFetchRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'webFetchRequestResponse',
            value: { result: { case: 'approved', value: {} } },
          },
        }),
      );
    case 'askQuestionInteractionQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'askQuestionInteractionResponse',
            value: { result: { result: { case: 'rejected', value: { reason: NON_INTERACTIVE } } } },
          },
        }),
      );
    case 'switchModeRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'switchModeRequestResponse',
            value: { result: { case: 'rejected', value: { reason: NON_INTERACTIVE } } },
          },
        }),
      );
    case 'createPlanRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'createPlanRequestResponse',
            value: { result: { result: { case: 'error', value: { error: NO_FILES } } } },
          },
        }),
      );
    default:
      throw new CursorProtocolError('cursor_interaction_unsupported', NON_INTERACTIVE);
  }
}

function encoded(response: InteractionResponse): Uint8Array {
  return frameConnectMessage(
    toBinary(
      AgentClientMessageSchema,
      create(AgentClientMessageSchema, {
        message: { case: 'interactionResponse', value: response },
      }),
    ),
  );
}
