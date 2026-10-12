import { expect, test } from 'bun:test';

import { create } from '@bufbuild/protobuf';

import { ExecServerMessageSchema } from '../../gen/agent_pb';
import { buildMcpToolDefinitions } from '../mcp-tools';
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

test('backgroundShellSpawn is rejected', () => {
  expect(
    (respondToExec(exec('backgroundShellSpawnArgs', { command: 'ls' })) as { value: { result: { case: string } } })
      .value.result.case,
  ).toBe('rejected');
});

test('native rejections steer the model to the forwarded client tools', () => {
  const tools = buildMcpToolDefinitions([
    { type: 'function', name: 'read_file', inputSchema: {} },
    { type: 'function', name: 'run_terminal_command', inputSchema: {} },
  ]);
  const reasonOf = (response: unknown) =>
    (response as { value: { result: { value: { reason: string } } } }).value.result.value.reason;
  const read = reasonOf(respondToExec(exec('readArgs', { path: '/x' }), tools));
  expect(read).toContain('CallDynamicTool with namespace "pi-agent"');
  expect(read).toContain('read_file, run_terminal_command');
  expect(reasonOf(respondToExec(exec('shellArgs', { command: 'ls' }), tools))).toBe(read);
  expect(reasonOf(respondToExec(exec('readArgs', { path: '/x' })))).toBe('Tool not available');
});
