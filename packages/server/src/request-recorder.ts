import type { RequestAttemptLog, RequestLogStore } from '@aio-proxy/core/db';
import type { RequestOutcome, UsageRow } from '@aio-proxy/types';

import {
  logServerEvent,
  type RequestRecorderPersistenceFailedLog,
  type ServerLogSink,
  serverErrorType,
} from './server-log';
import type { UsageCompletion } from './usage-capture';

const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UNPARSED_REQUESTED_MODEL_ID = '<unparsed>';

export type RequestRecorder = {
  readonly begin: (input: { readonly inboundProtocol: string; readonly requestedModelId?: string }) => RequestSession;
};

export type RequestAttemptInput = Omit<RequestAttemptLog, 'index'>;

export type RequestFinishInput = {
  readonly outcome: RequestOutcome;
  readonly attempt?: RequestAttemptInput;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalStatusCode?: number;
  readonly errorCode?: string;
  readonly usage?: UsageRow;
};

export type RequestSession = {
  readonly requestId: string;
  readonly identify: (input: { readonly requestedModelId: string }) => void;
  readonly attempt: (input: RequestAttemptInput) => void;
  readonly finish: (input: RequestFinishInput) => boolean;
  readonly finishFrom: (
    attempt: Omit<RequestAttemptInput, 'outcome' | 'statusCode' | 'errorCode'>,
    completion: Promise<UsageCompletion>,
  ) => void;
};

type RecorderContext = {
  readonly store: RequestLogStore;
  readonly logger: ServerLogSink | undefined;
  readonly now: () => Date;
  lastPrunedAt: Date;
};

type SessionState = {
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly startedAt: Date;
  readonly attempts: RequestAttemptLog[];
  requestedModelId: string;
  identified: boolean;
  status: 'pending' | 'async-owned' | 'finished';
};

export function createRequestRecorder(options: {
  readonly store: RequestLogStore;
  readonly now?: () => Date;
  readonly logger?: ServerLogSink;
}): RequestRecorder {
  const now = options.now ?? (() => new Date());
  const context: RecorderContext = { store: options.store, logger: options.logger, now, lastPrunedAt: now() };
  persistSafely(() => context.store.prune(new Date(context.lastPrunedAt.getTime() - RETENTION_MS)), context.logger, {
    operation: 'prune',
  });

  return {
    begin: (input) => beginSession(context, input),
  };
}

function beginSession(
  context: RecorderContext,
  input: { readonly inboundProtocol: string; readonly requestedModelId?: string },
): RequestSession {
  const current = context.now();
  if (current.getTime() - context.lastPrunedAt.getTime() >= PRUNE_INTERVAL_MS) {
    context.lastPrunedAt = current;
    persistSafely(() => context.store.prune(new Date(current.getTime() - RETENTION_MS)), context.logger, {
      operation: 'prune',
    });
  }

  const state: SessionState = {
    requestId: crypto.randomUUID(),
    inboundProtocol: input.inboundProtocol,
    startedAt: current,
    attempts: [],
    requestedModelId: input.requestedModelId ?? UNPARSED_REQUESTED_MODEL_ID,
    identified: input.requestedModelId !== undefined,
    status: 'pending',
  };

  return {
    requestId: state.requestId,
    identify(identity) {
      if (state.status !== 'pending') return;
      if (!state.identified) {
        state.requestedModelId = identity.requestedModelId;
        state.identified = true;
        return;
      }
      if (state.requestedModelId === identity.requestedModelId) return;
      if (context.logger !== undefined) {
        logServerEvent(context.logger, {
          event: 'request.recorder_invariant',
          requestId: state.requestId,
          invariant: 'requested_model_conflict',
        });
      }
    },
    attempt(attempt) {
      if (state.status === 'pending') {
        state.attempts.push({ ...attempt, index: state.attempts.length });
      }
    },
    finish(finish) {
      if (state.status !== 'pending') return false;
      completeSession(context, state, finish);
      return true;
    },
    finishFrom(attempt, completion) {
      if (state.status !== 'pending') return;
      state.status = 'async-owned';
      void completion.then(
        (terminal) => {
          if (state.status !== 'async-owned') return;
          const statusCode = 'statusCode' in terminal ? terminal.statusCode : undefined;
          const errorCode = terminal.outcome === 'failure' ? terminal.errorCode : undefined;
          completeSession(context, state, {
            outcome: terminal.outcome,
            finalProviderId: attempt.providerId,
            finalModelId: attempt.modelId,
            ...(statusCode === undefined ? {} : { finalStatusCode: statusCode }),
            ...(errorCode === undefined ? {} : { errorCode }),
            attempt: {
              ...attempt,
              outcome: terminal.outcome,
              ...(statusCode === undefined ? {} : { statusCode }),
              ...(errorCode === undefined ? {} : { errorCode }),
            },
            ...(terminal.outcome === 'success' && terminal.usage !== undefined ? { usage: terminal.usage } : {}),
          });
        },
        () => {
          if (state.status !== 'async-owned') return;
          completeSession(context, state, {
            outcome: 'failure',
            finalProviderId: attempt.providerId,
            finalModelId: attempt.modelId,
            attempt: { ...attempt, outcome: 'failure' },
          });
        },
      );
    },
  };
}

function completeSession(context: RecorderContext, state: SessionState, finish: RequestFinishInput): void {
  state.status = 'finished';
  if (finish.attempt !== undefined) {
    state.attempts.push({ ...finish.attempt, index: state.attempts.length });
  }
  const completedAt = context.now();
  const base = {
    requestId: state.requestId,
    inboundProtocol: state.inboundProtocol,
    requestedModelId: state.requestedModelId,
    ...(finish.finalProviderId === undefined ? {} : { finalProviderId: finish.finalProviderId }),
    ...(finish.finalModelId === undefined ? {} : { finalModelId: finish.finalModelId }),
    ...(finish.finalStatusCode === undefined ? {} : { finalStatusCode: finish.finalStatusCode }),
    ...(finish.errorCode === undefined ? {} : { errorCode: finish.errorCode }),
    attempts: state.attempts,
    startedAt: state.startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt.getTime() - state.startedAt.getTime()),
  };
  persistSafely(
    () => {
      if (finish.outcome === 'success' && finish.usage !== undefined) {
        context.store.insertFinal({
          ...base,
          outcome: 'success',
          finalProviderId: finish.finalProviderId ?? finish.usage.providerId,
          finalModelId: finish.finalModelId ?? finish.usage.modelId,
          usage: finish.usage,
        });
      } else if (finish.outcome === 'success') {
        context.store.insertFinal({ ...base, outcome: 'success' });
      } else {
        context.store.insertFinal({ ...base, outcome: finish.outcome });
      }
    },
    context.logger,
    { operation: 'insert_final', requestId: state.requestId },
  );
}

function persistSafely(
  task: () => void,
  logger: ServerLogSink | undefined,
  failure: Omit<RequestRecorderPersistenceFailedLog, 'errorType' | 'event'>,
): void {
  try {
    task();
  } catch (error) {
    if (logger !== undefined) {
      logServerEvent(logger, {
        event: 'request.recorder_persistence_failed',
        ...failure,
        errorType: serverErrorType(error),
      });
    }
  }
}
