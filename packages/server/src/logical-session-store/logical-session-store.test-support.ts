import type {
  LogicalSessionRepository,
  SessionAffinityObservation,
  SessionIdentity,
  SessionResponseResolution,
} from './logical-session-store';

type StubRepositoryOptions = {
  readonly responses?: Map<string, SessionResponseResolution>;
  readonly affinities?: Map<string, SessionAffinityObservation>;
  readonly resolveError?: Error;
  readonly affinityError?: Error;
};

export function stubRepository(options: StubRepositoryOptions = {}): LogicalSessionRepository & {
  readonly lastResolveResponse: string | undefined;
  readonly lastFindAffinity: { identity: SessionIdentity; requestedModelId: string } | undefined;
  readonly findAffinityCalls: number;
} {
  const responses = options.responses ?? new Map<string, SessionResponseResolution>();
  const affinities = options.affinities ?? new Map<string, SessionAffinityObservation>();
  let lastResolveResponse: string | undefined;
  let lastFindAffinity: { identity: SessionIdentity; requestedModelId: string } | undefined;
  let findAffinityCalls = 0;
  return {
    get lastResolveResponse() {
      return lastResolveResponse;
    },
    get lastFindAffinity() {
      return lastFindAffinity;
    },
    get findAffinityCalls() {
      return findAffinityCalls;
    },
    resolveResponse(responseId, _now) {
      lastResolveResponse = responseId;
      if (options.resolveError !== undefined) throw options.resolveError;
      return responses.get(responseId);
    },
    findAffinity(identity, requestedModelId, _now) {
      findAffinityCalls += 1;
      lastFindAffinity = { identity, requestedModelId };
      if (options.affinityError !== undefined) throw options.affinityError;
      return affinities.get(`${identity.source}:${identity.id}:${requestedModelId}`);
    },
  };
}
