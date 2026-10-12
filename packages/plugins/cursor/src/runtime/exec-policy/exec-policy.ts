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
  type ExecClientResponse,
  fetchError,
  grepError,
  lsRejected,
  NOT_AVAILABLE,
  NOT_IMPLEMENTED,
  readRejected,
  shellRejected,
  unsupportedResult,
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
  uri?: string;
  command?: string;
  workingDirectory?: string;
};

// Cursor hides forwarded tools behind CallDynamicTool, so models reach for
// native Shell/Read first and, told only that they are unavailable, often give
// up in prose. Spelling out the dynamic call steers them to the client tools.
export function nativeUnavailableReason(tools: readonly McpToolDefinition[]): string {
  const namespace = tools[0]?.providerIdentifier;
  if (namespace === undefined) return NOT_AVAILABLE;
  const names = tools.map((tool) => tool.toolName).join(', ');
  return `${NOT_AVAILABLE} in this environment. Use the client's tools instead: call CallDynamicTool with namespace "${namespace}" and toolName set to one of: ${names}.`;
}

// Every unavailable operation has an explicit failure. An unset result oneof
// leaves the upstream executor without a terminal answer.
export function respondToExec(exec: ExecServerMessage, tools: readonly McpToolDefinition[] = []): ExecClientResponse {
  const reason = nativeUnavailableReason(tools);
  const args = (exec.message.value ?? undefined) as ExecArgs | undefined;
  const path = args?.path ?? '';
  const shell = { command: args?.command ?? '', workingDirectory: args?.workingDirectory ?? '' };
  switch (exec.message.case) {
    case 'readArgs':
      return readRejected({ path, reason });
    case 'lsArgs':
      return lsRejected({ path, reason });
    case 'grepArgs':
      return grepError(reason);
    case 'writeArgs':
      return writeRejected({ path, reason });
    case 'deleteArgs':
      return deleteRejected({ path, reason });
    case 'diagnosticsArgs':
      return diagnosticsRejected({ path, reason });
    case 'shellArgs':
    case 'shellStreamArgs':
      return shellRejected({ ...shell, reason });
    case 'backgroundShellSpawnArgs':
      return backgroundShellRejected({ ...shell, reason: NOT_IMPLEMENTED });
    case 'writeShellStdinArgs':
      return writeShellStdinError(NOT_IMPLEMENTED);
    case 'fetchArgs':
      return fetchError(args?.url ?? '', NOT_IMPLEMENTED);
    case 'listMcpResourcesExecArgs':
      return unsupportedResult('listMcpResourcesExecResult');
    case 'readMcpResourceExecArgs':
      return unsupportedResult('readMcpResourceExecResult', args?.uri);
    case 'recordScreenArgs':
      return unsupportedResult('recordScreenResult');
    case 'computerUseArgs':
      return unsupportedResult('computerUseResult');
    default:
      return { error: 'Unknown exec message variant; this client does not implement it.' };
  }
}
