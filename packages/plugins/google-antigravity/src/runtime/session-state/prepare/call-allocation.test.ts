import { expect, test } from "bun:test";
import type { ReplayPart } from "../../../protocol/replay-cache";
import { allocateCallOccurrences, type CallOccurrence } from "./call-allocation";

const MODEL = "claude-opus-4-6-thinking";
const CALL_COUNT = 3_000;

test("allocates a large compatible turn without a dense request-sized matrix", () => {
  const occurrences = Array.from({ length: CALL_COUNT }, (_, index) => occurrence(index));
  const candidates = Array.from({ length: CALL_COUNT }, (_, index) => candidate(CALL_COUNT - index - 1));
  const candidateIndexes = Array.from({ length: CALL_COUNT }, (_, index) => index);

  const startedAt = performance.now();
  const matches = allocateCallOccurrences(candidates, occurrences, candidateIndexes, MODEL);
  const elapsed = performance.now() - startedAt;

  expect(matches).toHaveLength(CALL_COUNT);
  expect(new Set(matches.map((match) => match.candidateIndex)).size).toBe(CALL_COUNT);
  matches.forEach((match, index) => {
    expect(candidates[match.candidateIndex]?.thoughtSignature).toBe(signature(index));
  });
  expect(elapsed).toBeLessThan(2_500);
});

function occurrence(index: number): CallOccurrence {
  const part: ReplayPart = {
    type: "function-call",
    contentIndex: 0,
    partIndex: index,
    call: call(),
    signature: signature(index),
  };
  return { part: part as Extract<ReplayPart, { type: "function-call" }>, replayIndex: index };
}

function candidate(index: number) {
  return { functionCall: call(), thoughtSignature: signature(index) };
}

function call() {
  return { name: "weather", args: { city: "Paris" } };
}

function signature(index: number): string {
  return `${index % 2 === 0 ? "even" : "odd"}-large-allocation-signature-`.padEnd(64, "x");
}
