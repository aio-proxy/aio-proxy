import { create } from '@bufbuild/protobuf';

import { ClientHeartbeatSchema } from '../../gen/agent_pb';
import type { CursorH2Stream } from '../../wire/transport';
import { encodeClientMessage } from '../client-messages';

export function startCursorHeartbeat(
  run: CursorH2Stream,
  intervalMs: number | undefined,
  onFailure: (error: unknown) => void,
): ReturnType<typeof setInterval> | undefined {
  if (intervalMs === undefined || intervalMs <= 0) return undefined;
  const frame = encodeClientMessage({ case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) });
  return setInterval(() => {
    try {
      run.write(frame);
    } catch (error) {
      onFailure(error);
    }
  }, intervalMs);
}
