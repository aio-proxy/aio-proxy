import { m } from '@aio-proxy/i18n';
import type { UsageCaller } from '@aio-proxy/types';

export const usageCallerLabel = (caller?: UsageCaller): string =>
  caller === undefined || caller.kind === 'legacy'
    ? m['dashboard.callers.legacy']()
    : caller.kind === 'anonymous'
      ? m['dashboard.callers.anonymous']()
      : caller.label || caller.id;
