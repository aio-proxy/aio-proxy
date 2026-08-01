import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ClientHeartbeatSchema,
  type ConversationStateStructure,
  type McpToolDefinition,
} from '../gen/agent_pb';
import { CONNECT_END_STREAM_FLAG, frameConnectMessage, parseConnectEndStream } from '../wire/frame';
import type { CursorTransport } from '../wire/transport';
import { encodeExecResponse, encodeKvResponse } from './client-messages';
import { createCursorStreamAccumulator, finalizeCursorStream, mapInteractionUpdate } from './stream';

export type CursorTurnResult = {
  readonly conversationState: ConversationStateStructure;
  readonly checkpointUsable: boolean;
  readonly pendingToolCalls: Map<string, string>;
  readonly blobStore: Map<string, Uint8Array>;
};

export function runCursorTurn(input: {
  readonly transport: CursorTransport;
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  readonly requestBytes: Uint8Array;
  readonly initialConversationState: ConversationStateStructure;
  readonly requestContextTools: McpToolDefinition[];
  readonly blobStore: Map<string, Uint8Array>;
  readonly heartbeatMs?: number;
}): { stream: ReadableStream<LanguageModelV4StreamPart>; result: Promise<CursorTurnResult> } {
  const accumulator = createCursorStreamAccumulator();
  const pendingToolCalls = new Map<string, string>();
  let conversationState = input.initialConversationState;
  let settle!: (result: CursorTurnResult) => void;
  let fail!: (error: unknown) => void;
  const result = new Promise<CursorTurnResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const h2 = await input.transport.openRun({
          accessToken: input.accessToken,
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        h2.write(frameConnectMessage(input.requestBytes));
        if (input.heartbeatMs !== undefined && input.heartbeatMs > 0) {
          heartbeat = setInterval(() => h2.write(heartbeatFrame()), input.heartbeatMs);
        }
        let endStreamError: string | undefined;
        for await (const frame of h2.frames) {
          if ((frame.flags & CONNECT_END_STREAM_FLAG) !== 0) {
            endStreamError = parseConnectEndStream(frame.payload).error?.message;
            continue;
          }
          const message = fromBinary(AgentServerMessageSchema, frame.payload).message;
          if (message.case === 'interactionUpdate') {
            for (const part of mapInteractionUpdate(message.value, accumulator)) controller.enqueue(part);
          } else if (message.case === 'kvServerMessage') {
            const reply = encodeKvResponse(message.value, input.blobStore);
            if (reply !== undefined) h2.write(reply);
          } else if (message.case === 'execServerMessage') {
            h2.write(encodeExecResponse(message.value, input.requestContextTools));
          } else if (message.case === 'conversationCheckpointUpdate') {
            conversationState = message.value;
          }
        }
        const trailers = await h2.trailers;
        if (endStreamError !== undefined) throw new Error(`Cursor stream error: ${endStreamError}`);
        const grpcStatus = trailers['grpc-status'];
        if (grpcStatus !== undefined && grpcStatus !== '0') {
          throw new Error(`Cursor gRPC status ${grpcStatus}: ${trailers['grpc-message'] ?? ''}`);
        }
        if (!accumulator.sawTurnEnded) throw new Error('Cursor stream ended before turnEnded');
        for (const part of finalizeCursorStream(accumulator)) controller.enqueue(part);
        controller.close();
        settle({
          conversationState,
          checkpointUsable: accumulator.toolCalls === 0,
          pendingToolCalls,
          blobStore: input.blobStore,
        });
      } catch (error) {
        controller.error(error);
        fail(error);
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
      }
    },
  });
  return { stream, result };
}

function heartbeatFrame(): Uint8Array {
  const message = create(AgentClientMessageSchema, {
    message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, message));
}
