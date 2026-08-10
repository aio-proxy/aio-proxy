import { expect, test } from 'bun:test';

import { create } from '@bufbuild/protobuf';

import { ExecServerMessageSchema } from '../gen/agent_pb';
import { respondToExec } from './exec-policy';

const exec = (messageCase: string, value: Record<string, unknown> = {}) =>
  create(ExecServerMessageSchema, {
    id: 1,
    execId: 'e',
    message: { case: messageCase, value },
  } as never);

test('read is rejected via ReadResult.rejected', () => {
  const response = respondToExec(exec('readArgs', { path: '/x', toolCallId: 't' }));
  expect(response).toMatchObject({ messageCase: 'readResult' });
  expect((response as { value: { result: { case: string } } }).value.result.case).toBe('rejected');
});

test('grep has no rejected variant and is answered with GrepResult.error', () => {
  const response = respondToExec(exec('grepArgs', { pattern: 'x', toolCallId: 't' }));
  expect(response).toMatchObject({ messageCase: 'grepResult' });
  expect((response as { value: { result: { case: string } } }).value.result.case).toBe('error');
});

test('fetch and writeShellStdin are Not implemented errors', () => {
  expect(respondToExec(exec('fetchArgs', { url: 'https://x' }))).toMatchObject({ messageCase: 'fetchResult' });
  expect(respondToExec(exec('writeShellStdinArgs'))).toMatchObject({ messageCase: 'writeShellStdinResult' });
});

test('backgroundShellSpawn is rejected; listMcpResources is an empty result', () => {
  expect(
    (respondToExec(exec('backgroundShellSpawnArgs', { command: 'ls' })) as { value: { result: { case: string } } })
      .value.result.case,
  ).toBe('rejected');
  expect(respondToExec(exec('listMcpResourcesExecArgs'))).toMatchObject({
    messageCase: 'listMcpResourcesExecResult',
  });
});

test('an unknown exec case is a bare ack', () => {
  expect(respondToExec(exec('someFutureArgs'))).toEqual({ ack: true });
});

test('shellStreamArgs returns one terminal exit event with code 1', () => {
  const responses = [respondToExec(exec('shellStreamArgs', { command: 'exit 0' }))];
  expect(responses).toHaveLength(1);
  expect(responses[0]).toMatchObject({
    messageCase: 'shellStream',
    value: { event: { case: 'exit', value: { code: 1 } } },
  });
});
