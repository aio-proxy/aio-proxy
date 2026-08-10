import { create } from '@bufbuild/protobuf';

import {
  type ExecServerMessage,
  type McpToolDefinition,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
} from '../../gen/agent_pb';
import {
  backgroundShellRejected,
  deleteRejected,
  diagnosticsRejected,
  emptyResult,
  type ExecClientResponse,
  fetchError,
  grepError,
  lsRejected,
  NOT_AVAILABLE,
  NOT_IMPLEMENTED,
  readRejected,
  shellRejected,
  shellStreamExit,
  writeRejected,
  writeShellStdinError,
} from '../exec-results';

export type { ExecClientResponse } from '../exec-results';

// Advertises the caller's B-class tools back to Cursor with no filesystem/shell
// content. Emits NO synthesized native tool-call blocks.
export function buildRequestContextResult(tools: McpToolDefinition[]): {
  messageCase: 'requestContextResult';
  value: unknown;
} {
  const requestContext = create(RequestContextSchema, {
    rules: [],
    repositoryInfo: [],
    tools,
    gitRepos: [],
    projectLayouts: [],
    mcpInstructions: [],
    fileContents: {},
    customSubagents: [],
  });
  return {
    messageCase: 'requestContextResult',
    value: create(RequestContextResultSchema, {
      result: { case: 'success', value: create(RequestContextSuccessSchema, { requestContext }) },
    }),
  };
}

type ExecArgs = {
  path?: string;
  url?: string;
  command?: string;
  workingDirectory?: string;
};

// Pure per-case mapping to the protocol-legal reply for a proxy with NO
// filesystem/shell. Heterogeneous by oneof case: rejected / error / empty / ack.
export function respondToExec(exec: ExecServerMessage): ExecClientResponse {
  const args = (exec.message.value ?? undefined) as ExecArgs | undefined;
  const path = args?.path ?? '';
  const shell = { command: args?.command ?? '', workingDirectory: args?.workingDirectory ?? '' };
  switch (exec.message.case) {
    case 'readArgs':
      return readRejected({ path, reason: NOT_AVAILABLE });
    case 'lsArgs':
      return lsRejected({ path, reason: NOT_AVAILABLE });
    case 'grepArgs':
      return grepError(NOT_AVAILABLE);
    case 'writeArgs':
      return writeRejected({ path, reason: NOT_AVAILABLE });
    case 'deleteArgs':
      return deleteRejected({ path, reason: NOT_AVAILABLE });
    case 'diagnosticsArgs':
      return diagnosticsRejected({ path, reason: NOT_AVAILABLE });
    case 'shellArgs':
      return shellRejected({ ...shell, reason: NOT_AVAILABLE });
    case 'shellStreamArgs':
      return shellStreamExit(1);
    case 'backgroundShellSpawnArgs':
      return backgroundShellRejected({ ...shell, reason: NOT_IMPLEMENTED });
    case 'writeShellStdinArgs':
      return writeShellStdinError(NOT_IMPLEMENTED);
    case 'fetchArgs':
      return fetchError(args?.url ?? '', NOT_IMPLEMENTED);
    case 'listMcpResourcesExecArgs':
      return emptyResult('listMcpResourcesExecResult');
    case 'readMcpResourceExecArgs':
      return emptyResult('readMcpResourceExecResult');
    case 'recordScreenArgs':
      return emptyResult('recordScreenResult');
    case 'computerUseArgs':
      return emptyResult('computerUseResult');
    default:
      return { ack: true };
  }
}
