import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { expect, test } from 'bun:test';

import { AgentClientMessageSchema, ClientHeartbeatSchema } from './agent_pb';

test('agent_pb round-trips a heartbeat client message', () => {
  const message = create(AgentClientMessageSchema, {
    message: { case: 'clientHeartbeat', value: create(ClientHeartbeatSchema, {}) },
  });
  const bytes = toBinary(AgentClientMessageSchema, message);
  const decoded = fromBinary(AgentClientMessageSchema, bytes);
  expect(decoded.message.case).toBe('clientHeartbeat');
});
