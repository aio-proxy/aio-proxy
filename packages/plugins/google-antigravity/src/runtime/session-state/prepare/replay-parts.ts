import { isEqual } from "es-toolkit/predicate";

import type { ReplayPart } from "../../../protocol/replay-cache";

import { validThoughtSignature } from "../../../protocol/signatures";
import { asRecord } from "../payload-shape";

export type FunctionCallReplayPart = Extract<ReplayPart, { type: "function-call" }>;

export function orderedReplayParts(parts: readonly ReplayPart[]): readonly ReplayPart[] {
  const ordered = [...parts].sort(
    (left, right) => left.contentIndex - right.contentIndex || left.partIndex - right.partIndex,
  );
  const unique: ReplayPart[] = [];
  for (const part of ordered) {
    const index = unique.findIndex((candidate) => sameOccurrence(candidate, part));
    if (index < 0) {
      unique.push(part);
      continue;
    }
    const existing = unique[index];
    if (existing?.type === "function-call" && existing.signature === undefined && part.signature !== undefined) {
      unique[index] = { ...existing, signature: part.signature };
    }
  }
  return unique;
}

function sameOccurrence(left: ReplayPart, right: ReplayPart): boolean {
  if (left.type !== right.type || left.contentIndex !== right.contentIndex || left.partIndex !== right.partIndex) {
    return false;
  }
  return (
    left.type === "thought-signature" ||
    (right.type === "function-call" && compatibleReplayCalls(left.call, right.call))
  );
}

export function replayPart(part: ReplayPart, modelId: string): readonly Record<string, unknown>[] {
  if (part.type === "thought-signature") {
    return validThoughtSignature(modelId, part.signature)
      ? [{ text: "", thought: true, thoughtSignature: part.signature }]
      : [];
  }
  if (part.signature !== undefined && !validThoughtSignature(modelId, part.signature)) return [];
  return [{ functionCall: part.call, ...(part.signature === undefined ? {} : { thoughtSignature: part.signature }) }];
}

export function compatibleHistoryCall(history: unknown, replay: unknown): boolean {
  const leftCall = canonicalCall(history);
  const rightCall = canonicalCall(replay);
  if (leftCall === undefined || rightCall === undefined || !sameCallFields(leftCall, rightCall)) return false;
  return leftCall.id === undefined || rightCall.id === undefined || leftCall.id === rightCall.id;
}

export function callAllocationKey(value: unknown): string | undefined {
  const call = canonicalCall(value);
  return call === undefined ? undefined : `${JSON.stringify(call.name)}\u0000${canonicalValueKey(call.args)}`;
}

export function sameCanonicalCallFields(left: unknown, right: unknown): boolean {
  const leftCall = canonicalCall(left);
  const rightCall = canonicalCall(right);
  return leftCall !== undefined && rightCall !== undefined && sameCallFields(leftCall, rightCall);
}

type CanonicalCall = { readonly args: unknown; readonly id: string | undefined; readonly name: string };

function compatibleReplayCalls(left: unknown, right: unknown): boolean {
  const leftCall = canonicalCall(left);
  const rightCall = canonicalCall(right);
  if (leftCall === undefined || rightCall === undefined || !sameCallFields(leftCall, rightCall)) return false;
  return leftCall.id === undefined || rightCall.id === undefined || leftCall.id === rightCall.id;
}

function canonicalCall(value: unknown): CanonicalCall | undefined {
  const call = asRecord(value);
  const id = Reflect.get(call ?? {}, "id");
  const name = Reflect.get(call ?? {}, "name");
  if (call === undefined || (id != null && typeof id !== "string") || typeof name !== "string") return undefined;
  const args = Reflect.get(call, "args");
  return {
    args: args === undefined ? {} : args,
    id: typeof id === "string" ? id : undefined,
    name,
  };
}

function sameCallFields(left: CanonicalCall, right: CanonicalCall): boolean {
  return left.name === right.name && isEqual(left.args, right.args);
}

function canonicalValueKey(value: unknown): string {
  if (value === null) return framedValue("n", "");
  if (Array.isArray(value)) return framedValue("a", value.map(canonicalValueKey).join(""));
  const record = asRecord(value);
  if (record !== undefined) {
    return framedValue(
      "o",
      Object.keys(record)
        .sort()
        .map((key) => framedValue("k", key) + canonicalValueKey(Reflect.get(record, key)))
        .join(""),
    );
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return framedValue("d", "NaN");
    if (Object.is(value, -0)) return framedValue("d", "-0");
  }
  const tag = {
    bigint: "i",
    boolean: "b",
    function: "f",
    number: "d",
    object: "x",
    string: "s",
    symbol: "y",
    undefined: "u",
  }[typeof value];
  return framedValue(tag, String(value));
}

function framedValue(tag: string, payload: string): string {
  return `${tag}${payload.length}:${payload}`;
}
