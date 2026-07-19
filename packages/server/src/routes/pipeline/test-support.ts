import { REQUEST_BODY_LIMITS } from "@aio-proxy/core";

import type { UsageCompletion } from "../../usage-capture";

import {
  createProtocolContext,
  defineProtocolAdapter,
  defineProviderRouteSource,
  type FakeProvider,
} from "../../../_test/pipeline-helpers";
import { handleProtocolRequest } from "./index";

export const MAX_BODY_BYTES = REQUEST_BODY_LIMITS.encoded;

export function pipeline(
  fixtures: readonly FakeProvider[],
  options: {
    readonly adapter?: ReturnType<typeof defineProtocolAdapter>;
    readonly immediateStreamCompletion?: UsageCompletion;
  } = {},
) {
  const adapter = options.adapter ?? defineProtocolAdapter();
  const context = createProtocolContext();
  const route = defineProviderRouteSource(fixtures, options.immediateStreamCompletion);
  return {
    ...route,
    adapter,
    context,
    run: (rawRequest: Request) => handleProtocolRequest({ adapter, context, rawRequest, source: route.source }),
  };
}

export function attemptsOf(recording: ReturnType<typeof defineProviderRouteSource>["recording"]) {
  return recording.attempts.map(({ outcome, providerId, statusCode }) => ({ outcome, providerId, statusCode }));
}
