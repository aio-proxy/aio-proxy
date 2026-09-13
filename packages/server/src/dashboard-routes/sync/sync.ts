import type {
  SyncApplyInput,
  SyncBackendView,
  SyncCancelDetachInput,
  SyncControlPlane,
  SyncDetachInput,
  SyncHistoryItem,
  SyncPreview,
  SyncPreviewInput,
  SyncRangeInput,
  SyncStatus,
} from '@aio-proxy/types';
import {
  SyncApplyInputSchema,
  SyncCancelDetachInputSchema,
  SyncDetachInputSchema,
  SyncPreviewInputSchema,
  SyncRangeInputSchema,
} from '@aio-proxy/types';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';

import { publishSyncChanged, type DashboardEventHub } from '../../dashboard-events';
import { SyncOperationError, SyncPreviewError } from '../../sync-control-plane';

const objectIdSchema = z.string().min(1);

type SyncErrorCode =
  | 'preview-stale'
  | 'invalid-request'
  | 'not-connected'
  | 'dependency-in-use'
  | 'detach-required'
  | 'operation-pending'
  | 'upgrade-required'
  | 'backend-unavailable';

type SyncResponse =
  | { readonly ok: false; readonly error: { readonly code: SyncErrorCode } }
  | SyncStatus
  | SyncPreview
  | { readonly backends: readonly SyncBackendView[] }
  | { readonly items: readonly SyncHistoryItem[] };

const disconnectedStatus: SyncStatus = {
  state: 'disconnected',
  backend: null,
  providers: [],
  pendingOperations: 0,
  lastSuccessAt: null,
};

const unavailableSync: SyncControlPlane = {
  status: () => disconnectedStatus,
  backends: () => [],
  preview: async () => {
    throw new SyncOperationError('backend-unavailable');
  },
  apply: async () => {
    throw new SyncOperationError('backend-unavailable');
  },
  setRange: async () => {
    throw new SyncOperationError('backend-unavailable');
  },
  detach: async () => {
    throw new SyncOperationError('backend-unavailable');
  },
  cancelDetach: async () => {
    throw new SyncOperationError('backend-unavailable');
  },
  history: async () => {
    throw new SyncOperationError('backend-unavailable');
  },
  retry: async () => {
    throw new SyncOperationError('backend-unavailable');
  },
  disconnect: async () => {
    throw new SyncOperationError('backend-unavailable');
  },
};

const invalidRequest = (context: { json: (value: SyncResponse, status: 400) => Response }): Response =>
  context.json({ ok: false, error: { code: 'invalid-request' } }, 400);

function errorCode(error: unknown): { readonly code: SyncErrorCode; readonly status: 400 | 409 | 503 } {
  const code =
    error instanceof SyncPreviewError || error instanceof SyncOperationError ? error.code : 'backend-unavailable';
  if (code === 'invalid-request') return { code, status: 400 };
  if (code === 'not-connected' || code === 'backend-unavailable') return { code, status: 503 };
  return { code, status: 409 };
}

function errorResponse(context: { json: (value: SyncResponse, status: 400 | 409 | 503) => Response }, error: unknown) {
  const mapped = errorCode(error);
  return context.json({ ok: false, error: { code: mapped.code } }, mapped.status);
}

function bodyValidator<T>(schema: z.ZodType<T>) {
  return (async (context, next) => {
    const contentType = context.req.header('content-type') ?? '';
    if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/iu.test(contentType)) return invalidRequest(context);
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      return invalidRequest(context);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return invalidRequest(context);
    context.req.addValidatedData('json', parsed.data as {});
    return next();
  }) satisfies MiddlewareHandler;
}

function validatedJson(context: { readonly req: { readonly valid: (target: never) => unknown } }): unknown {
  return context.req.valid('json' as never);
}

export const createSyncRoutes = (sync: SyncControlPlane | undefined, events?: DashboardEventHub) => {
  const control = sync ?? unavailableSync;

  const run = async <T>(
    context: { json: (value: SyncResponse, status?: 200 | 400 | 409 | 503) => Response },
    operation: () => T | Promise<T>,
    changed = false,
  ): Promise<Response> => {
    try {
      const result = await operation();
      if (changed) publishSyncChanged(events, control.status().state);
      return context.json(result as SyncResponse);
    } catch (error) {
      return errorResponse(context, error);
    }
  };

  return new Hono()
    .get('/', (context) => run(context, () => control.status()))
    .get('/backends', (context) => run(context, () => ({ backends: control.backends() })))
    .post('/preview', bodyValidator(SyncPreviewInputSchema), (context) =>
      run(context, () => control.preview(validatedJson(context) as SyncPreviewInput), true),
    )
    .post('/apply', bodyValidator(SyncApplyInputSchema), (context) =>
      run(context, () => control.apply(validatedJson(context) as SyncApplyInput), true),
    )
    .put('/range', bodyValidator(SyncRangeInputSchema), (context) => {
      const input = validatedJson(context) as SyncRangeInput;
      return run(context, () => control.setRange(input.providerId, input.included), true);
    })
    .post('/detach', bodyValidator(SyncDetachInputSchema), (context) => {
      const input = validatedJson(context) as SyncDetachInput;
      return run(context, () => control.detach(input.providerId, input.loginSessionId), true);
    })
    .post('/detach/cancel', bodyValidator(SyncCancelDetachInputSchema), (context) => {
      const input = validatedJson(context) as SyncCancelDetachInput;
      return run(context, () => control.cancelDetach(input.providerId), true);
    })
    .get('/history/:objectId', (context) => {
      const parsed = objectIdSchema.safeParse(context.req.param('objectId'));
      if (!parsed.success) return invalidRequest(context);
      return run(context, async () => ({ items: await control.history(parsed.data) }));
    })
    .post('/retry', (context) => run(context, () => control.retry(), true))
    .post('/disconnect', (context) => run(context, () => control.disconnect(), true));
};
