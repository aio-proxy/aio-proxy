import { ProviderProtocol } from '@aio-proxy/types';
import { context } from '@opentelemetry/api';

import { withRequestLogContext } from '../../request-logging';
import type { RequestTraceSession } from '../../request-tracing';
import type { ProviderSnapshotLease } from '../../runtime';
import type { HandleProtocolRequestOptions } from './index';
import { cancelRetainedRequestBody } from './request';

/** Owns the early lease until parsing transfers it to the candidate loop. */
export async function withProtocolRequestObservation<TRequest, TContext>(
  options: HandleProtocolRequestOptions<TRequest, TContext>,
  run: (
    options: HandleProtocolRequestOptions<TRequest, TContext>,
    session: RequestTraceSession,
    protocol: ProviderProtocol,
    lease?: ProviderSnapshotLease,
    transferLease?: () => void,
  ) => Promise<Response>,
): Promise<Response> {
  const inboundProtocol = options.adapter.protocol;
  const lease =
    inboundProtocol === ProviderProtocol.OpenAIResponse ? options.source.acquireProviderSnapshot() : undefined;
  let transferred = false;
  try {
    const policy =
      lease === undefined
        ? undefined
        : await options.source.preObservationCapturePolicy?.(
            options.rawRequest,
            lease.snapshot,
            options.adapter.bodyLimits(options.rawRequest, options.context).encoded,
          );
    if (lease !== undefined && options.rawRequest.signal.aborted) {
      void cancelRetainedRequestBody(options.rawRequest, options.rawRequest.signal.reason);
      options.rawRequest.signal.throwIfAborted();
    }
    return await withRequestLogContext(
      {
        requestId: '',
        debug: options.source.debugLogging === true,
        logger: options.source.logger,
        ...(policy === undefined ? {} : policy),
      },
      async () => {
        const session = options.source.requestRecorder.begin({
          inboundRequest: options.rawRequest,
          inboundProtocol,
          ...(options.httpRoute === undefined ? {} : { httpRoute: options.httpRoute }),
        });
        return context.with(session.rootContext, () =>
          withRequestLogContext(
            {
              requestId: session.requestId,
              debug: options.source.debugLogging === true,
              logger: options.source.logger,
              rootContext: session.rootContext,
              ...(policy === undefined ? {} : policy),
            },
            () =>
              run(options, session, inboundProtocol, lease, () => {
                transferred = true;
              }),
          ),
        );
      },
    );
  } finally {
    if (!transferred) lease?.release();
  }
}
