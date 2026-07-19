import { expect, test } from "bun:test";

import { appendSseReplayPayload, completedSseReplay, createSseReplayState } from "./session-state/replay-accumulator";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "signature-".repeat(6);

test("incremental SSE state retains replay parts and terminal state but not large response payloads", () => {
  const marker = `large-irrelevant-${"x".repeat(256_000)}`;
  const state = createSseReplayState();

  appendSseReplayPayload(state, MODEL, {
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: marker },
              {
                functionCall: { id: "call-1", name: "weather", args: {} },
                thoughtSignature: SIGNATURE,
              },
            ],
            unrelated: marker,
          },
          finishReason: "STOP",
          unrelated: marker,
        },
      ],
      unrelated: marker,
    },
    unrelated: marker,
  });

  expect(completedSseReplay(state)?.parts).toEqual([
    {
      type: "function-call",
      contentIndex: 0,
      partIndex: 1,
      call: { id: "call-1", name: "weather", args: {} },
      signature: SIGNATURE,
    },
  ]);
  expect(JSON.stringify(state)).not.toContain("large-irrelevant");
});

test.each([
  "MALFORMED_FUNCTION_CALL",
  "MAX_TOKENS",
  "IMAGE_SAFETY",
  "RECITATION",
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "FINISH_REASON_UNSPECIFIED",
  "OTHER",
  "UNEXPECTED_TOOL_CALL",
])("does not complete replay for Google finish reason %s", (finishReason) => {
  const state = createSseReplayState();

  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-1", finishReason, 0)]));

  expect(completedSseReplay(state)).toBeUndefined();
});

test("requires every relevant candidate to finish successfully", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(
    state,
    MODEL,
    responsePayload([candidate("call-1", "STOP", 0), candidate("call-2", undefined, 1)]),
  );

  expect(completedSseReplay(state)).toBeUndefined();
});

test("fails closed when multiple candidates finish with STOP", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(
    state,
    MODEL,
    responsePayload([candidate("call-1", "STOP", 0), candidate("call-2", "STOP", 1)]),
  );

  expect(state.outcome).toBe("failure");
  expect(completedSseReplay(state)).toBeUndefined();
});

test("fails closed when one response repeats an explicit candidate index", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(
    state,
    MODEL,
    responsePayload([candidate("call-1", undefined, 0), candidate("call-2", "STOP", 0)]),
  );

  expect(state.outcome).toBe("failure");
  expect(state.parts).toEqual([]);
  expect(completedSseReplay(state)).toBeUndefined();
});

test("fails closed when a second indexed candidate appears across frames", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(
    state,
    MODEL,
    responsePayload([candidate("call-1", "STOP", 0), candidate("call-2", undefined, 1)]),
  );
  expect(state.outcome).toBe("failure");
  expect(completedSseReplay(state)).toBeUndefined();
});

test("fails closed when a new indexed candidate follows provisional success", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-1", "STOP", 0)]));
  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-2", undefined, 1)]));

  expect(state.outcome).toBe("failure");
  expect(completedSseReplay(state)).toBeUndefined();
});

test("fails closed when candidate identity changes from explicit index to fallback position", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-1", "STOP", 0)]));
  appendSseReplayPayload(state, MODEL, responsePayload([candidateWithoutIndex("call-2", undefined)]));

  expect(state.outcome).toBe("failure");
  expect(completedSseReplay(state)).toBeUndefined();
});

test("does not recover completion after candidate content arrives after STOP", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-1", "STOP", 0)]));
  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-2", undefined, 0)]));

  expect(completedSseReplay(state)).toBeUndefined();
});

test("allows a usage-only frame after successful completion", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-1", "STOP", 0)]));
  appendSseReplayPayload(state, MODEL, { response: { usageMetadata: { candidatesTokenCount: 1 } } });

  expect(completedSseReplay(state)?.parts).toMatchObject([{ type: "function-call", call: { id: "call-1" } }]);
});

test("keeps failure absorbing when a later candidate reports STOP", () => {
  const state = createSseReplayState();

  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-1", "MALFORMED_FUNCTION_CALL", 0)]));
  appendSseReplayPayload(state, MODEL, responsePayload([candidate("call-1", "STOP", 0)]));

  expect(completedSseReplay(state)).toBeUndefined();
});

function responsePayload(candidates: readonly unknown[]) {
  return { response: { candidates } };
}

function candidate(id: string, finishReason: string | undefined, index: number) {
  return {
    index,
    ...candidateWithoutIndex(id, finishReason),
  };
}

function candidateWithoutIndex(id: string, finishReason: string | undefined) {
  return {
    content: {
      role: "model",
      parts: [
        {
          functionCall: { id, name: "weather", args: {} },
          thoughtSignature: SIGNATURE,
        },
      ],
    },
    ...(finishReason === undefined ? {} : { finishReason }),
  };
}
