import type { UsageRow } from '@aio-proxy/types';

import type { LogicalSessionResolution } from '../../logical-session-store';

export type RequestTraceIdentityInput = {
  readonly requestedModelId: string;
  readonly resolution: LogicalSessionResolution;
  readonly mutateSessionState: boolean;
  readonly streamRequested?: boolean;
};

type RequestTraceFinishBase = {
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalHttpStatus?: number;
  readonly ttftMs?: number;
};

export type RequestTraceFinishInput =
  | (RequestTraceFinishBase & {
      readonly outcome: 'success';
      readonly usage?: UsageRow;
      readonly responseId?: string;
    })
  | (RequestTraceFinishBase & {
      readonly outcome: 'failure';
      readonly errorType?: string;
      readonly errorCode?: string;
    })
  | (RequestTraceFinishBase & { readonly outcome: 'cancelled' });
