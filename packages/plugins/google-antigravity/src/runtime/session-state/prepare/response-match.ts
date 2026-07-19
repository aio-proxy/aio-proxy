import { asArray, asRecord } from "../payload-shape";
import { compatibleHistoryCall, type FunctionCallReplayPart } from "./replay-parts";

export type ReplayBoundary = { readonly modelIndex?: number; readonly responseIndex: number };

type ResponseCallMatch = {
  readonly call: FunctionCallReplayPart;
  readonly response: Readonly<Record<string, unknown>>;
};

export function matchingReplayBoundary(
  contents: readonly unknown[],
  calls: readonly FunctionCallReplayPart[],
): ReplayBoundary | undefined {
  return searchBoundaries(contents, calls, exactIdMatch) ?? searchBoundaries(contents, calls, fallbackNameMatch);
}

function searchBoundaries(
  contents: readonly unknown[],
  calls: readonly FunctionCallReplayPart[],
  responseMatches: (call: Readonly<Record<string, unknown>>, response: Readonly<Record<string, unknown>>) => boolean,
): ReplayBoundary | undefined {
  for (let responseIndex = contents.length - 1; responseIndex >= 0; responseIndex -= 1) {
    const matches = responseCallMatches(contents[responseIndex], calls, responseMatches);
    if (matches.length === 0) continue;
    const boundary = modelBoundary(contents, responseIndex, matches);
    if (boundary !== undefined) return boundary;
  }
  return undefined;
}

function responseCallMatches(
  contentValue: unknown,
  calls: readonly FunctionCallReplayPart[],
  responseMatches: (call: Readonly<Record<string, unknown>>, response: Readonly<Record<string, unknown>>) => boolean,
): readonly ResponseCallMatch[] {
  const responses = asArray(Reflect.get(asRecord(contentValue) ?? {}, "parts")).flatMap((part) => {
    const response = asRecord(Reflect.get(asRecord(part) ?? {}, "functionResponse"));
    return response === undefined ? [] : [response];
  });
  return calls.flatMap((call) => {
    const callValue = asRecord(call.call);
    if (callValue === undefined) return [];
    return responses.filter((response) => responseMatches(callValue, response)).map((response) => ({ call, response }));
  });
}

function modelBoundary(
  contents: readonly unknown[],
  responseIndex: number,
  matches: readonly ResponseCallMatch[],
): ReplayBoundary | undefined {
  const modelIndex = responseIndex - 1;
  if (modelIndex < 0) return { responseIndex };
  const model = asRecord(contents[modelIndex]);
  if (model === undefined || hasFunctionResponse(model) || Reflect.get(model, "role") !== "model") {
    return { responseIndex };
  }
  const modelCalls = asArray(Reflect.get(model, "parts")).flatMap((part) => {
    const call = Reflect.get(asRecord(part) ?? {}, "functionCall");
    return call === undefined ? [] : [call];
  });
  if (modelCalls.length === 0) return { responseIndex };
  return matches.some((match) => matchingBoundaryCall(modelCalls, match)) ? { modelIndex, responseIndex } : undefined;
}

function matchingBoundaryCall(modelCalls: readonly unknown[], match: ResponseCallMatch): boolean {
  const responseId = Reflect.get(match.response, "id");
  if (typeof responseId !== "string") {
    return modelCalls.some((modelCall) => compatibleHistoryCall(modelCall, match.call.call));
  }
  const exactIdCalls = modelCalls.filter((modelCall) => Reflect.get(asRecord(modelCall) ?? {}, "id") === responseId);
  const candidates =
    exactIdCalls.length > 0
      ? exactIdCalls
      : modelCalls.filter((modelCall) => Reflect.get(asRecord(modelCall) ?? {}, "id") === undefined);
  return candidates.some((modelCall) => compatibleHistoryCall(modelCall, match.call.call));
}

function exactIdMatch(call: Readonly<Record<string, unknown>>, response: Readonly<Record<string, unknown>>): boolean {
  const callId = Reflect.get(call, "id");
  const responseId = Reflect.get(response, "id");
  return typeof callId === "string" && typeof responseId === "string" && callId === responseId;
}

function fallbackNameMatch(
  call: Readonly<Record<string, unknown>>,
  response: Readonly<Record<string, unknown>>,
): boolean {
  const callId = Reflect.get(call, "id");
  const responseId = Reflect.get(response, "id");
  if (typeof callId === "string" && typeof responseId === "string") return false;
  return Reflect.get(call, "name") === Reflect.get(response, "name");
}

function hasFunctionResponse(content: Readonly<Record<string, unknown>> | undefined): boolean {
  return asArray(Reflect.get(content ?? {}, "parts")).some(
    (part) => asRecord(Reflect.get(asRecord(part) ?? {}, "functionResponse")) !== undefined,
  );
}
