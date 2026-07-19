import { expect, test } from "bun:test";

import { prepareReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "response-boundary-signature-".repeat(3);

test("skips a newer ID-less response whose adjacent model call has incompatible args", () => {
  const olderModel = modelTurn(call(undefined, "Paris"), "older-compatible");
  const olderResponse = responseTurn(response(undefined, "weather"));
  const newerModel = modelTurn(call(undefined, "London"), "newer-stale");
  const newerResponse = responseTurn(response(undefined, "weather"));
  const body = { contents: [olderModel, olderResponse, newerModel, newerResponse] };

  expect(preparedContents(body, call(undefined, "Paris"))).toEqual([
    signedModelTurn(call(undefined, "Paris"), "older-compatible"),
    olderResponse,
    newerModel,
    newerResponse,
  ]);
});

test("prefers an older exact-ID response over a newer compatible ID-less response", () => {
  const exactModel = modelTurn(call("target", "Paris"), "exact");
  const exactResponse = responseTurn(response("target", "weather"));
  const fallbackModel = modelTurn(call(undefined, "Paris"), "fallback");
  const fallbackResponse = responseTurn(response(undefined, "weather"));
  const body = { contents: [exactModel, exactResponse, fallbackModel, fallbackResponse] };

  expect(preparedContents(body, call("target", "Paris"))).toEqual([
    signedModelTurn(call("target", "Paris"), "exact"),
    exactResponse,
    fallbackModel,
    fallbackResponse,
  ]);
});

test("skips a newer exact-ID response whose adjacent model call has incompatible args", () => {
  const olderModel = modelTurn(call("target", "Paris"), "older-compatible");
  const olderResponse = responseTurn(response("target", "weather"));
  const newerModel = modelTurn(call("target", "London"), "newer-stale");
  const newerResponse = responseTurn(response("target", "weather"));
  const body = { contents: [olderModel, olderResponse, newerModel, newerResponse] };

  expect(preparedContents(body, call("target", "Paris"))).toEqual([
    signedModelTurn(call("target", "Paris"), "older-compatible"),
    olderResponse,
    newerModel,
    newerResponse,
  ]);
});

test("matches a generated model and response ID to an ID-less replay call", () => {
  const existingModel = modelTurn(call("generated", "Paris"), "generated");
  const existingResponse = responseTurn(response("generated", "weather"));
  const body = { contents: [existingModel, existingResponse] };

  expect(preparedContents(body, call(undefined, "Paris"))).toEqual([
    signedModelTurn(call("generated", "Paris"), "generated"),
    existingResponse,
  ]);
});

test("does not insert before a response whose adjacent model turn has an incompatible call", () => {
  const staleModel = modelTurn(call(undefined, "London"), "stale");
  const staleResponse = responseTurn(response(undefined, "weather"));
  const body = { contents: [staleModel, staleResponse] };

  expect(preparedContents(body, call(undefined, "Paris"))).toEqual(body.contents);
});

test("does not associate an exact-ID response with a different ID-less model call", () => {
  const exactButStale = call("target", "London");
  const unrelatedCompatible = call(undefined, "Paris");
  const adjacentModel = {
    role: "model",
    parts: [
      { functionCall: exactButStale, providerMetadata: { retained: "exact-stale" } },
      { functionCall: unrelatedCompatible, providerMetadata: { retained: "unrelated-idless" } },
    ],
  };
  const exactResponse = responseTurn(response("target", "weather"));
  const body = { contents: [adjacentModel, exactResponse] };

  expect(preparedContents(body, call("target", "Paris"))).toEqual(body.contents);
});

test("matches the compatible call associated with one of multiple tool responses", () => {
  const searchCall = { id: "search", name: "search", args: { query: "Paris" } };
  const weatherCall = call("generated-weather", "Paris");
  const existingModel = {
    role: "model",
    parts: [
      { functionCall: searchCall, providerMetadata: { retained: "search" } },
      { functionCall: weatherCall, providerMetadata: { retained: "weather" } },
    ],
  };
  const existingResponse = responseTurn(response("search", "search"), response("generated-weather", "weather"));
  const body = { contents: [existingModel, existingResponse] };

  expect(preparedContents(body, call(undefined, "Paris"))).toEqual([
    {
      role: "model",
      parts: [existingModel.parts[0], { ...existingModel.parts[1], thoughtSignature: SIGNATURE }],
    },
    existingResponse,
  ]);
});

function preparedContents(
  body: Readonly<Record<string, unknown>> & { readonly contents: readonly unknown[] },
  replayCall: unknown,
): readonly unknown[] {
  return prepareReasoningReplay(body, MODEL, {
    parts: [{ type: "function-call", contentIndex: 0, partIndex: 0, call: replayCall, signature: SIGNATURE }],
  }).contents;
}

function modelTurn(functionCall: unknown, retained: string) {
  return { role: "model", parts: [{ functionCall, providerMetadata: { retained } }] };
}

function signedModelTurn(functionCall: unknown, retained: string) {
  return {
    role: "model",
    parts: [{ functionCall, providerMetadata: { retained }, thoughtSignature: SIGNATURE }],
  };
}

function responseTurn(...parts: readonly Record<string, unknown>[]) {
  return { role: "user", parts };
}

function response(id: string | undefined, name: string) {
  return { functionResponse: { ...(id === undefined ? {} : { id }), name, response: { ok: true } } };
}

function call(id: string | undefined, city: string) {
  return { ...(id === undefined ? {} : { id }), name: "weather", args: { city } };
}
