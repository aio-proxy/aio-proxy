import { isEqual } from "es-toolkit/predicate";

import type { ReplayPart } from "../../../protocol/replay-cache";

import { validThoughtSignature } from "../../../protocol/signatures";
import { asArray, asRecord } from "../payload-shape";
import { allocateCallOccurrences, type CallOccurrence } from "./call-allocation";
import { compatibleHistoryCall, replayPart } from "./replay-parts";

export function enrichModelTurn(
  body: Readonly<Record<string, unknown>>,
  contents: readonly unknown[],
  modelIndex: number,
  replay: readonly ReplayPart[],
  modelId: string,
): Record<string, unknown> {
  const model = asRecord(contents[modelIndex]);
  if (model === undefined) return body;
  const parts = [...asArray(Reflect.get(model, "parts"))];
  const replacement = buildReplacement(parts, replay, modelId);
  if (replacement === undefined || isEqual(parts, replacement)) return body;
  const nextContents = [...contents];
  nextContents[modelIndex] = { ...model, parts: replacement };
  return { ...body, contents: nextContents };
}

function buildReplacement(
  parts: readonly unknown[],
  replay: readonly ReplayPart[],
  modelId: string,
): readonly unknown[] | undefined {
  const anchors: (number | undefined)[] = replay.map(() => undefined);
  const replacements = new Map<number, Record<string, unknown>>();
  const removed = new Set<number>();
  const matchedThoughts = new Set<number>();
  let hasMatch = false;
  replay.forEach((part, replayIndex) => {
    if (part.type === "thought-signature") {
      const index = parts.findIndex(
        (candidate, candidateIndex) =>
          !matchedThoughts.has(candidateIndex) && Reflect.get(asRecord(candidate) ?? {}, "thought") === true,
      );
      if (index >= 0) {
        anchors[replayIndex] = index;
        matchedThoughts.add(index);
        hasMatch = true;
        const existing = asRecord(parts[index]);
        if (existing !== undefined) replacements.set(index, signThought(existing, part.signature, modelId));
      }
      return;
    }
  });

  const occurrences = callOccurrences(replay);
  const callIndexes = matchingCallIndexes(parts, occurrences);
  for (const index of callIndexes) removed.add(index);
  const matches = allocateCallOccurrences(parts, occurrences, callIndexes, modelId);
  const slots = callIndexes.slice(0, matches.length);
  for (const slot of slots) removed.delete(slot);
  matches.forEach(({ candidateIndex, part, replayIndex }, callIndex) => {
    const slot = slots[callIndex];
    if (slot === undefined) return;
    hasMatch = true;
    anchors[replayIndex] = slot;
    const retained = asRecord(parts[candidateIndex]);
    if (retained !== undefined) replacements.set(slot, signFunctionCall(retained, part.signature, modelId));
  });

  if (!hasMatch) return undefined;
  const insertions = missingReplayInsertions(replay, anchors, parts.length, modelId);
  const result: unknown[] = [];
  for (let index = 0; index <= parts.length; index += 1) {
    result.push(...(insertions.get(index) ?? []));
    if (index === parts.length || removed.has(index)) continue;
    result.push(replacements.get(index) ?? parts[index]);
  }
  return result;
}

function callOccurrences(replay: readonly ReplayPart[]): readonly CallOccurrence[] {
  const occurrences: CallOccurrence[] = [];
  replay.forEach((part, replayIndex) => {
    if (part.type !== "function-call") return;
    occurrences.push({ part, replayIndex });
  });
  return occurrences;
}

function missingReplayInsertions(
  replay: readonly ReplayPart[],
  anchors: readonly (number | undefined)[],
  endIndex: number,
  modelId: string,
): ReadonlyMap<number, readonly Record<string, unknown>[]> {
  const insertions = new Map<number, Record<string, unknown>[]>();
  replay.forEach((part, replayIndex) => {
    if (anchors[replayIndex] !== undefined) return;
    const nextAnchor = anchors.slice(replayIndex + 1).find((anchor) => anchor !== undefined);
    const index = nextAnchor ?? endIndex;
    const values = replayPart(part, modelId);
    if (values.length === 0) return;
    const bucket = insertions.get(index) ?? [];
    bucket.push(...values);
    insertions.set(index, bucket);
  });
  return insertions;
}

function matchingCallIndexes(parts: readonly unknown[], occurrences: readonly CallOccurrence[]): readonly number[] {
  const indexes: number[] = [];
  parts.forEach((part, index) => {
    const call = Reflect.get(asRecord(part) ?? {}, "functionCall");
    if (occurrences.some((occurrence) => compatibleHistoryCall(call, occurrence.part.call))) indexes.push(index);
  });
  return indexes;
}

function signThought(
  existing: Readonly<Record<string, unknown>>,
  signature: string,
  modelId: string,
): Record<string, unknown> {
  if (validThoughtSignature(modelId, Reflect.get(existing, "thoughtSignature"))) return { ...existing };
  return validThoughtSignature(modelId, signature) ? { ...existing, thoughtSignature: signature } : { ...existing };
}

function signFunctionCall(
  existing: Readonly<Record<string, unknown>>,
  signature: string | undefined,
  modelId: string,
): Record<string, unknown> {
  if (validThoughtSignature(modelId, signature)) {
    return Reflect.get(existing, "thoughtSignature") === signature
      ? { ...existing }
      : { ...existing, thoughtSignature: signature };
  }
  return { ...existing };
}
