import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import { AgentClientMessageSchema, AgentServerMessageSchema, type AgentRunRequest } from '../../gen/agent_pb';
import type { ConnectFrame } from '../../wire/frame';
import type { CursorTransport } from '../../wire/transport';

export type FixtureRootMessage = {
  role?: string;
  content?:
    | string
    | Array<{
        type?: string;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        text?: string;
      }>;
};

export const protocolServerFrame = (message: Record<string, unknown>): ConnectFrame => ({
  flags: 0,
  payload: toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message } as never)),
});
export const protocolUpdateFrame = (message: Record<string, unknown>): ConnectFrame =>
  protocolServerFrame({ case: 'interactionUpdate', value: { message } });

export function createProtocolFixture(rounds: readonly (readonly ConnectFrame[])[]) {
  const runs: AgentRunRequest[] = [];
  const roots: FixtureRootMessage[][] = [];
  const closes: number[] = [];
  let opened = 0;
  const transport: CursorTransport = {
    unary: async () => {
      throw new Error('unused');
    },
    openRun: async () => {
      const round = opened++;
      const script = rounds[round];
      if (script === undefined) throw new Error('unexpected extra Cursor Run');
      const queue: ConnectFrame[] = [];
      const trailers = Promise.withResolvers<Record<string, string>>();
      const pending = new Set<number>();
      let wake: (() => void) | undefined;
      let closed = false;
      roots[round] = [];
      closes[round] = 0;
      const notify = () => {
        const next = wake;
        wake = undefined;
        next?.();
      };
      const sendScript = () => {
        queue.push(...script);
        notify();
      };
      return {
        write(bytes) {
          const message = fromBinary(AgentClientMessageSchema, bytes.subarray(5)).message;
          if (message.case === 'runRequest') {
            runs[round] = message.value;
            const ids = message.value.conversationState?.rootPromptMessagesJson ?? [];
            ids.forEach((blobId, index) => {
              pending.add(index + 1);
              queue.push(
                protocolServerFrame({
                  case: 'kvServerMessage',
                  value: {
                    id: index + 1,
                    message: { case: 'getBlobArgs', value: { blobId } },
                  },
                }),
              );
            });
            if (pending.size === 0) sendScript();
            else notify();
          } else if (message.case === 'kvClientMessage') {
            const reply = message.value;
            if (reply.message.case !== 'getBlobResult' || !pending.delete(reply.id)) {
              throw new Error('unexpected KV response');
            }
            const data = reply.message.value.blobData;
            if (data === undefined) throw new Error('root blob unavailable');
            roots[round]![reply.id - 1] = JSON.parse(new TextDecoder().decode(data)) as FixtureRootMessage;
            if (pending.size === 0) sendScript();
          }
        },
        end() {},
        close() {
          closes[round]++;
          closed = true;
          trailers.resolve({});
          notify();
        },
        trailers: trailers.promise,
        frames: (async function* () {
          for (;;) {
            if (closed) return;
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
      };
    },
  };
  return { transport, runs, roots, closes };
}
