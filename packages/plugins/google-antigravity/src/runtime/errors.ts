import { APICallError } from '@ai-sdk/provider';

export type AntigravityEndpointCategory = 'daily' | 'sandbox' | 'custom';
export type AntigravityFailureReason = 'upstream_network' | 'upstream_rate_limited' | 'upstream_no_capacity';

export class AntigravityUpstreamError extends Error {
  readonly endpoint: AntigravityEndpointCategory;
  readonly reason: AntigravityFailureReason;
  readonly retryable = true;
  readonly status?: number;

  constructor(input: {
    readonly endpoint: AntigravityEndpointCategory;
    readonly reason: AntigravityFailureReason;
    readonly status?: number;
  }) {
    super('Google Antigravity upstream request failed');
    this.endpoint = input.endpoint;
    this.reason = input.reason;
    if (input.status !== undefined) this.status = input.status;
  }

  override get name(): string {
    return 'AntigravityUpstreamError';
  }
}

// `@ai-sdk/provider-utils` re-raises anything thrown while reading an
// already-successful response body as an `APICallError` carrying this exact
// message, with the original failure on `cause`. That wrapper hides this
// plugin's own stream failure and a caller's verbatim abort reason, both of
// which are contracts callers rely on, so it is peeled off at the plugin's
// stream boundary. A genuine upstream API call error never carries this
// message and must keep surfacing as an API call error.
const SDK_STREAM_WRAPPER_MESSAGE = 'Failed to process successful response';

export function isSdkStreamFailureWrapper(error: unknown): error is APICallError {
  return APICallError.isInstance(error) && error.message === SDK_STREAM_WRAPPER_MESSAGE && error.cause !== undefined;
}

export function unwrapSdkStreamFailure(error: unknown): unknown {
  return isSdkStreamFailureWrapper(error) ? error.cause : error;
}
