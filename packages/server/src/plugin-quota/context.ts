import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

import {
  type OAuthAccountContextDependencies,
  OAuthAccountUnavailableError,
  type PreparedOAuthAccountContext,
  withOAuthAccountContext,
} from '../oauth-account-context';
import { OAuthQuotaCapabilityUnavailableError } from './errors';

export type OAuthQuotaServiceDependencies = OAuthAccountContextDependencies;
export type PreparedOAuthQuotaContext = PreparedOAuthAccountContext;
export type OAuthQuotaCapabilityHandle = NonNullable<OAuthAdapter['quota']>;

export async function withOAuthQuotaContext<T>(
  dependencies: OAuthQuotaServiceDependencies,
  providerId: string,
  signal: AbortSignal,
  operation: (prepared: PreparedOAuthQuotaContext, quota: OAuthQuotaCapabilityHandle) => Promise<T>,
): Promise<T> {
  try {
    return await withOAuthAccountContext(
      dependencies,
      { providerId, signal, select: (adapter: OAuthAdapter) => adapter.quota },
      operation,
    );
  } catch (error) {
    // Preserve the quota module's own error identity — the cache latches on `permanent`.
    if (error instanceof OAuthAccountUnavailableError) {
      throw new OAuthQuotaCapabilityUnavailableError(error.permanent);
    }
    throw error;
  }
}
