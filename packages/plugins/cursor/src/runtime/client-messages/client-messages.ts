import { create, toBinary } from '@bufbuild/protobuf';

import {
  type AgentClientMessage,
  AgentClientMessageSchema,
  ExecClientMessageSchema,
  type ExecServerMessage,
  GetBlobResultSchema,
  KvClientMessageSchema,
  type KvServerMessage,
  type McpToolDefinition,
  SetBlobResultSchema,
} from '../../gen/agent_pb';
import { blobKey } from '../../store/blobs';
import { frameConnectMessage } from '../../wire/frame';
import { buildRequestContextResult, respondToExec } from '../exec-policy';

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
    return frame({ case: 'kvClientMessage', value: response });
  }
  if (kv.message.case === 'setBlobArgs') {
    blobStore.set(blobKey(kv.message.value.blobId), kv.message.value.blobData);
    const response = create(KvClientMessageSchema, {
      id: kv.id,
      message: { case: 'setBlobResult', value: create(SetBlobResultSchema, {}) },
    });
    return frame({ case: 'kvClientMessage', value: response });
  }
  return undefined;
}

// Where Task 9's pure ExecClientResponse becomes wire bytes. requestContext is
// answered with the caller's advertised B-class tools; every other exec case
// follows respondToExec, and an unknown case sends a bare id+execId ack.
export function encodeExecResponse(exec: ExecServerMessage, requestContextTools: McpToolDefinition[]): Uint8Array {
  const response =
    exec.message.case === 'requestContextArgs' ? buildRequestContextResult(requestContextTools) : respondToExec(exec);
  if ('ack' in response) {
    const ack = create(ExecClientMessageSchema, { id: exec.id, execId: exec.execId });
    return frame({ case: 'execClientMessage', value: ack });
  }
  const execClient = create(ExecClientMessageSchema, {
    id: exec.id,
    execId: exec.execId,
    message: { case: response.messageCase, value: response.value } as never,
  });
  return frame({ case: 'execClientMessage', value: execClient });
}

function frame(message: AgentClientMessage['message']): Uint8Array {
  const client = create(AgentClientMessageSchema, { message } as never);
  return frameConnectMessage(toBinary(AgentClientMessageSchema, client));
}
