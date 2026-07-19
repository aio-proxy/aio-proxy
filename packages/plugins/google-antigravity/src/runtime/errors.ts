export type AntigravityEndpointCategory = "daily" | "prod" | "custom";
export type AntigravityFailureReason = "upstream_network" | "upstream_rate_limited" | "upstream_no_capacity";

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
    super("Google Antigravity upstream request failed");
    this.endpoint = input.endpoint;
    this.reason = input.reason;
    if (input.status !== undefined) this.status = input.status;
  }

  override get name(): string {
    return "AntigravityUpstreamError";
  }
}
