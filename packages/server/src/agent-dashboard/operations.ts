import type {
  AgentOperationErrorCode,
  AgentOperationRequest,
  AgentOperationResult,
  AgentOperationState,
  AgentTarget,
} from '@aio-proxy/types';

import { AgentOperationError, type AgentOperationEvents } from './host-port';

const RETAIN_FINISHED_MS = 10 * 60_000;

export class AgentOperationBusyError extends Error {
  constructor() {
    super('operation_in_progress');
  }
}

type Entry = {
  state: AgentOperationState;
  readonly controller: AbortController;
  finishedAt?: number;
  outcome?: 'denied' | 'cancelled';
  deviceId?: string;
};

export type AgentOperationDevice = {
  readonly deviceId: string;
  readonly installationId: string;
  readonly userCode: string;
  readonly expiresAt: string;
};

type AgentOperationsInput = {
  readonly run: (request: AgentOperationRequest, events: AgentOperationEvents) => Promise<AgentOperationResult>;
  /** Resolves a user code the host reported into the challenge it names; undefined when it is not pending. */
  readonly resolveDevice: (target: AgentTarget, userCode: string) => AgentOperationDevice | undefined;
  readonly onUnknownError: (request: AgentOperationRequest, error: unknown) => void;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
};

export type AgentOperations = {
  readonly start: (request: AgentOperationRequest) => AgentOperationState;
  readonly get: (operationId: string) => AgentOperationState | undefined;
  /** The device awaiting approval for this operation, if it is in that state. */
  readonly device: (operationId: string) => string | undefined;
  readonly resume: (operationId: string) => AgentOperationState | undefined;
  readonly stop: (operationId: string, outcome: 'denied' | 'cancelled') => AgentOperationState | undefined;
  /** Settles every in-flight operation; used by tests and shutdown. */
  readonly settled: () => Promise<void>;
};

export function createAgentOperations(input: AgentOperationsInput): AgentOperations {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const entries = new Map<string, Entry>();
  const running = new Set<Promise<void>>();

  const prune = (): void => {
    const timestamp = now();
    for (const [id, entry] of entries)
      if (entry.finishedAt !== undefined && timestamp - entry.finishedAt >= RETAIN_FINISHED_MS) entries.delete(id);
  };
  const active = (target: AgentTarget): boolean =>
    [...entries.values()].some((entry) => entry.state.target === target && entry.finishedAt === undefined);
  const finish = (entry: Entry, next: AgentOperationState): void => {
    entry.state = next;
    entry.finishedAt = now();
  };
  const failure = (entry: Entry, error: unknown): AgentOperationErrorCode | undefined => {
    if (entry.outcome === 'denied') return 'authorization_denied';
    if (entry.outcome === 'cancelled') return 'cancelled';
    if (error instanceof AgentOperationError) return error.code;
    return undefined;
  };

  function start(request: AgentOperationRequest): AgentOperationState {
    prune();
    if (active(request.target)) throw new AgentOperationBusyError();
    const base = { operationId: randomUUID(), target: request.target, kind: request.kind };
    const entry: Entry = { state: { ...base, status: 'running' }, controller: new AbortController() };
    entries.set(base.operationId, entry);
    const events: AgentOperationEvents = {
      signal: entry.controller.signal,
      onDevice: ({ userCode }) => {
        const device = input.resolveDevice(request.target, userCode);
        if (device === undefined || entry.finishedAt !== undefined) return;
        entry.deviceId = device.deviceId;
        entry.state = {
          ...base,
          status: 'awaiting_approval',
          installationId: device.installationId,
          userCode: device.userCode,
          expiresAt: device.expiresAt,
        };
      },
    };
    const task = input
      .run(request, events)
      .then(
        (result) => {
          if (entry.outcome !== undefined) finish(entry, { ...base, status: 'failed', error: failure(entry, null)! });
          else finish(entry, { ...base, status: 'succeeded', result });
        },
        (error: unknown) => {
          const code = failure(entry, error);
          if (code === undefined) input.onUnknownError(request, error);
          finish(entry, { ...base, status: 'failed', error: code ?? 'unknown' });
        },
      )
      .finally(() => running.delete(task));
    running.add(task);
    return entry.state;
  }

  const lookup = (operationId: string): Entry | undefined => {
    prune();
    return entries.get(operationId);
  };

  return {
    start,
    get: (operationId) => lookup(operationId)?.state,
    device: (operationId) => {
      const entry = lookup(operationId);
      return entry?.state.status === 'awaiting_approval' ? entry.deviceId : undefined;
    },
    resume: (operationId) => {
      const entry = lookup(operationId);
      if (entry?.state.status !== 'awaiting_approval') return entry?.state;
      const { operationId: id, target, kind } = entry.state;
      entry.state = { operationId: id, target, kind, status: 'running' };
      return entry.state;
    },
    stop: (operationId, outcome) => {
      const entry = lookup(operationId);
      if (entry?.state.status !== 'awaiting_approval') return entry?.state;
      entry.outcome = outcome;
      entry.controller.abort();
      return entry.state;
    },
    settled: async () => {
      await Promise.all(running);
    },
  };
}
