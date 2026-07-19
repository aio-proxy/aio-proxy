import type { ReplayPart } from "../../protocol/replay-cache";
import { validThoughtSignature } from "../../protocol/signatures";
import { canonicalFunctionCallArgs } from "./function-call-args";
import { type PartialArg, PartialArgsAccumulator } from "./partial-args-accumulator";
import { asRecord } from "./payload-shape";

type ActiveStreamedCall = {
  readonly accumulator: PartialArgsAccumulator;
  readonly contentIndex: number;
  readonly id: string | undefined;
  readonly name: string;
  readonly partIndex: number;
  readonly signature: string | undefined;
};

export type StreamedFunctionCalls = { readonly active: Map<string, ActiveStreamedCall[]> };

type AppendResult = { readonly handled: boolean; readonly invalid?: boolean; readonly part?: ReplayPart };

export function createStreamedFunctionCalls(): StreamedFunctionCalls {
  return { active: new Map() };
}

export function appendFunctionCallPart(
  state: StreamedFunctionCalls,
  candidateKey: string,
  modelId: string,
  value: Readonly<Record<string, unknown>>,
  contentIndex: number,
  partIndex: number,
): AppendResult {
  if (!Object.hasOwn(value, "functionCall")) return { handled: false };
  const call = asRecord(Reflect.get(value, "functionCall"));
  if (call === undefined) return { handled: true, invalid: true };
  const parsed = parseFunctionCall(call);
  if (parsed === undefined) return { handled: true, invalid: true };
  const signatureValue = Reflect.get(value, "thoughtSignature");
  const signature = validThoughtSignature(modelId, signatureValue) ? signatureValue : undefined;
  const isStreaming = parsed.partialArgs !== undefined || (parsed.name !== undefined && parsed.willContinue === true);
  const isTerminal =
    parsed.name === undefined &&
    parsed.args === undefined &&
    parsed.partialArgs === undefined &&
    parsed.willContinue === undefined;

  if (isStreaming) return appendStreamingChunk(state, candidateKey, parsed, signature, contentIndex, partIndex);
  if (isTerminal) return appendResult(finishActiveCall(state, candidateKey));
  if (parsed.name === undefined) return { handled: true };
  return {
    handled: true,
    part: replayPart(
      parsed.id,
      parsed.name,
      canonicalFunctionCallArgs(parsed.args),
      signature,
      contentIndex,
      partIndex,
    ),
  };
}

function appendStreamingChunk(
  state: StreamedFunctionCalls,
  candidateKey: string,
  call: ParsedFunctionCall,
  signature: string | undefined,
  contentIndex: number,
  partIndex: number,
): AppendResult {
  let active: ActiveStreamedCall | undefined;
  if (call.name !== undefined) {
    const calls = activeCalls(state, candidateKey);
    active = {
      accumulator: new PartialArgsAccumulator(),
      contentIndex,
      id: call.id,
      name: call.name,
      partIndex,
      signature,
    };
    calls.push(active);
  } else {
    active = state.active.get(candidateKey)?.at(-1);
  }
  if (active === undefined || call.partialArgs === undefined) return { handled: true };
  if (!active.accumulator.append(call.partialArgs)) return { handled: true, invalid: true };
  const complete = call.willContinue !== true && call.partialArgs.every((arg) => arg.willContinue !== true);
  return complete ? appendResult(finishActiveCall(state, candidateKey)) : { handled: true };
}

function finishActiveCall(state: StreamedFunctionCalls, candidateKey: string): ReplayPart | undefined {
  const calls = state.active.get(candidateKey);
  const active = calls?.pop();
  if (active === undefined) return undefined;
  if (calls !== undefined && calls.length === 0) state.active.delete(candidateKey);
  return replayPart(
    active.id,
    active.name,
    active.accumulator.value(),
    active.signature,
    active.contentIndex,
    active.partIndex,
  );
}

function appendResult(part: ReplayPart | undefined): AppendResult {
  return part === undefined ? { handled: true } : { handled: true, part };
}

function activeCalls(state: StreamedFunctionCalls, candidateKey: string): ActiveStreamedCall[] {
  const existing = state.active.get(candidateKey);
  if (existing !== undefined) return existing;
  const created: ActiveStreamedCall[] = [];
  state.active.set(candidateKey, created);
  return created;
}

function replayPart(
  id: string | undefined,
  name: string,
  args: unknown,
  signature: string | undefined,
  contentIndex: number,
  partIndex: number,
): ReplayPart {
  return {
    type: "function-call",
    contentIndex,
    partIndex,
    call: { ...(id === undefined ? {} : { id }), name, args },
    ...(signature === undefined ? {} : { signature }),
  };
}

type ParsedFunctionCall = {
  readonly args: unknown | undefined;
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly partialArgs: readonly PartialArg[] | undefined;
  readonly willContinue: boolean | undefined;
};

function parseFunctionCall(call: Readonly<Record<string, unknown>>): ParsedFunctionCall | undefined {
  const idValue = Reflect.get(call, "id");
  const nameValue = Reflect.get(call, "name");
  const willContinueValue = Reflect.get(call, "willContinue");
  if (!isNullableString(idValue) || !isNullableString(nameValue) || !isNullableBoolean(willContinueValue)) {
    return undefined;
  }
  const partialArgsValue = Reflect.get(call, "partialArgs");
  const partialArgs = partialArgsValue == null ? undefined : parsePartialArgs(partialArgsValue);
  if (partialArgs === false) return undefined;
  const args = Reflect.get(call, "args");
  return {
    args,
    id: typeof idValue === "string" ? idValue : undefined,
    name: typeof nameValue === "string" ? nameValue : undefined,
    partialArgs,
    willContinue: typeof willContinueValue === "boolean" ? willContinueValue : undefined,
  };
}

function parsePartialArgs(value: unknown): readonly PartialArg[] | false {
  if (!Array.isArray(value)) return false;
  const result: PartialArg[] = [];
  for (const item of value) {
    const part = asRecord(item);
    const jsonPath = Reflect.get(part ?? {}, "jsonPath");
    if (part === undefined || typeof jsonPath !== "string" || !validPartialArgFields(part)) return false;
    result.push(part as PartialArg);
  }
  return result;
}

function validPartialArgFields(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isNullableString(Reflect.get(value, "stringValue")) &&
    isNullableNumber(Reflect.get(value, "numberValue")) &&
    isNullableBoolean(Reflect.get(value, "boolValue")) &&
    isNullableBoolean(Reflect.get(value, "willContinue"))
  );
}

function isNullableString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function isNullableNumber(value: unknown): boolean {
  return value == null || typeof value === "number";
}

function isNullableBoolean(value: unknown): boolean {
  return value == null || typeof value === "boolean";
}
