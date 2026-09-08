import { create, toBinary } from '@bufbuild/protobuf';

import {
  type AgentClientMessage,
  AgentClientMessageSchema,
  ExecClientControlMessageSchema,
  ExecClientStreamCloseSchema,
  ExecClientThrowSchema,
  ExecClientMessageSchema,
  type ExecServerMessage,
  GetBlobResultSchema,
  KvClientMessageSchema,
  type KvServerMessage,
  McpRejectedSchema,
  McpResultSchema,
  type McpToolDefinition,
  SetBlobResultSchema,
  ShellStreamSchema,
} from '../../gen/agent_pb';
import { blobKey } from '../../store/blobs';
import { frameConnectMessage } from '../../wire/frame';
import { buildRequestContextResult, respondToExec } from '../exec-policy';
import { NOT_AVAILABLE } from '../exec-results';

// Turns the shared blob store into KV responses Cursor can read back. Returns
// framed AgentClientMessage bytes, or undefined for an unknown KV case.
export function encodeKvResponse(kv: KvServerMessage, blobStore: Map<string, Uint8Array>): Uint8Array | undefined {
  if (kv.message.case === 'getBlobArgs') {
    const data = blobStore.get(blobKey(kv.message.value.blobId));
    const response = create(KvClientMessageSchema, {
      id: kv.id,
      message: {
        case: 'getBlobResult',
        value: create(GetBlobResultSchema, data ? { blobData: data } : {}),
      },
    });
    return encodeClientMessage({ case: 'kvClientMessage', value: response });
  }
  if (kv.message.case === 'setBlobArgs') {
    blobStore.set(blobKey(kv.message.value.blobId), kv.message.value.blobData);
    const response = create(KvClientMessageSchema, {
      id: kv.id,
      message: { case: 'setBlobResult', value: create(SetBlobResultSchema, {}) },
    });
    return encodeClientMessage({ case: 'kvClientMessage', value: response });
  }
  return undefined;
}

// Native execs may need multiple replies. Control messages close one exec id,
// leaving the enclosing Run available for the model to recover from rejection.
export function buildExecResponses(
  exec: ExecServerMessage,
  requestContextTools: McpToolDefinition[],
): AgentClientMessage['message'][] {
  const response =
    exec.message.case === 'requestContextArgs' ? buildRequestContextResult(requestContextTools) : respondToExec(exec);
  if ('error' in response) {
    return [
      {
        case: 'execClientControlMessage',
        value: create(ExecClientControlMessageSchema, {
          message: { case: 'throw', value: create(ExecClientThrowSchema, { id: exec.id, error: response.error }) },
        }),
      },
      execStreamClose(exec.id),
    ];
  }
  const reply: AgentClientMessage['message'] = {
    case: 'execClientMessage',
    value: create(ExecClientMessageSchema, {
      id: exec.id,
      execId: exec.execId,
      message: { case: response.messageCase, value: response.value } as never,
    }),
  };
  if (exec.message.case !== 'shellStreamArgs') return [reply];
  // An exit event alone does not complete a streamed exec. Match the native
  // executor's result + streamClose handshake even when no command was run.
  const events = [
    create(ShellStreamSchema, { event: { case: 'start', value: {} } }),
    create(ShellStreamSchema, { event: { case: 'stderr', value: { data: NOT_AVAILABLE } } }),
    create(ShellStreamSchema, {
      event: { case: 'exit', value: { code: 1, cwd: exec.message.value.workingDirectory, aborted: true } },
    }),
  ];
  return [
    ...events.map((value): AgentClientMessage['message'] => ({
      case: 'execClientMessage',
      value: create(ExecClientMessageSchema, {
        id: exec.id,
        execId: exec.execId,
        message: { case: 'shellStream', value },
      }),
    })),
    reply,
    execStreamClose(exec.id),
  ];
}

function execStreamClose(id: number): AgentClientMessage['message'] {
  return {
    case: 'execClientControlMessage',
    value: create(ExecClientControlMessageSchema, {
      message: { case: 'streamClose', value: create(ExecClientStreamCloseSchema, { id }) },
    }),
  };
}

export function encodeMcpApprovalRejection(exec: ExecServerMessage): Uint8Array {
  return encodeClientMessage({
    case: 'execClientMessage',
    value: create(ExecClientMessageSchema, {
      id: exec.id,
      execId: exec.execId,
      message: {
        case: 'mcpResult',
        value: create(McpResultSchema, {
          result: {
            case: 'rejected',
            value: create(McpRejectedSchema, {
              reason: 'Tool approval is owned by the external client.',
            }),
          },
        }),
      },
    }),
  });
}

export function encodeClientMessage(message: AgentClientMessage['message']): Uint8Array {
  const client = create(AgentClientMessageSchema, { message } as never);
  return frameConnectMessage(toBinary(AgentClientMessageSchema, client));
}
