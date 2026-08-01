import { create } from '@bufbuild/protobuf';

import {
  BackgroundShellSpawnResultSchema,
  ComputerUseResultSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DiagnosticsRejectedSchema,
  DiagnosticsResultSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  ListMcpResourcesExecResultSchema,
  LsRejectedSchema,
  LsResultSchema,
  ReadMcpResourceExecResultSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RecordScreenResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
} from '../gen/agent_pb';

export type ExecClientResponse = { readonly messageCase: string; readonly value?: unknown } | { readonly ack: true };

export const NOT_IMPLEMENTED = 'Not implemented';
export const NOT_AVAILABLE = 'Tool not available';

type PathReject = { readonly path: string; readonly reason: string };
type ShellReject = { readonly command: string; readonly workingDirectory: string; readonly reason: string };

export function readRejected(fields: PathReject): ExecClientResponse {
  return {
    messageCase: 'readResult',
    value: create(ReadResultSchema, { result: { case: 'rejected', value: create(ReadRejectedSchema, fields) } }),
  };
}

export function lsRejected(fields: PathReject): ExecClientResponse {
  return {
    messageCase: 'lsResult',
    value: create(LsResultSchema, { result: { case: 'rejected', value: create(LsRejectedSchema, fields) } }),
  };
}

export function grepError(error: string): ExecClientResponse {
  return {
    messageCase: 'grepResult',
    value: create(GrepResultSchema, { result: { case: 'error', value: create(GrepErrorSchema, { error }) } }),
  };
}

export function writeRejected(fields: PathReject): ExecClientResponse {
  return {
    messageCase: 'writeResult',
    value: create(WriteResultSchema, { result: { case: 'rejected', value: create(WriteRejectedSchema, fields) } }),
  };
}

export function deleteRejected(fields: PathReject): ExecClientResponse {
  return {
    messageCase: 'deleteResult',
    value: create(DeleteResultSchema, { result: { case: 'rejected', value: create(DeleteRejectedSchema, fields) } }),
  };
}

export function diagnosticsRejected(fields: PathReject): ExecClientResponse {
  return {
    messageCase: 'diagnosticsResult',
    value: create(DiagnosticsResultSchema, {
      result: { case: 'rejected', value: create(DiagnosticsRejectedSchema, fields) },
    }),
  };
}

export function shellRejected(fields: ShellReject): ExecClientResponse {
  return {
    messageCase: 'shellResult',
    value: create(ShellResultSchema, {
      result: { case: 'rejected', value: create(ShellRejectedSchema, { ...fields, isReadonly: false }) },
    }),
  };
}

export function shellStreamExit(code: number): ExecClientResponse {
  return {
    messageCase: 'shellStream',
    value: create(ShellStreamSchema, { event: { case: 'exit', value: create(ShellStreamExitSchema, { code }) } }),
  };
}

export function backgroundShellRejected(fields: ShellReject): ExecClientResponse {
  return {
    messageCase: 'backgroundShellSpawnResult',
    value: create(BackgroundShellSpawnResultSchema, {
      result: { case: 'rejected', value: create(ShellRejectedSchema, { ...fields, isReadonly: false }) },
    }),
  };
}

export function writeShellStdinError(error: string): ExecClientResponse {
  return {
    messageCase: 'writeShellStdinResult',
    value: create(WriteShellStdinResultSchema, {
      result: { case: 'error', value: create(WriteShellStdinErrorSchema, { error }) },
    }),
  };
}

export function fetchError(url: string, error: string): ExecClientResponse {
  return {
    messageCase: 'fetchResult',
    value: create(FetchResultSchema, { result: { case: 'error', value: create(FetchErrorSchema, { url, error }) } }),
  };
}

export function emptyResult(
  messageCase: 'listMcpResourcesExecResult' | 'readMcpResourceExecResult' | 'recordScreenResult' | 'computerUseResult',
): ExecClientResponse {
  switch (messageCase) {
    case 'listMcpResourcesExecResult':
      return { messageCase, value: create(ListMcpResourcesExecResultSchema, {}) };
    case 'readMcpResourceExecResult':
      return { messageCase, value: create(ReadMcpResourceExecResultSchema, {}) };
    case 'recordScreenResult':
      return { messageCase, value: create(RecordScreenResultSchema, {}) };
    case 'computerUseResult':
      return { messageCase, value: create(ComputerUseResultSchema, {}) };
  }
}
