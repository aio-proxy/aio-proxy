import { expect, test } from "bun:test";

import { prepareReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "signature-".repeat(6);

test("inserts replay before the latest same-name function response when IDs are absent", () => {
  const oldModel = { role: "model", parts: [{ functionCall: { name: "weather", args: { city: "old" } } }] };
  const oldResponse = {
    role: "user",
    parts: [{ functionResponse: { name: "weather", response: { city: "old" } } }],
  };
  const currentResponse = {
    role: "user",
    parts: [{ functionResponse: { name: "weather", response: { city: "current" } } }],
  };
  const body = {
    contents: [oldModel, oldResponse, { role: "user", parts: [{ text: "weather again" }] }, currentResponse],
  };

  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: [replayCall({ name: "weather", args: { city: "current" } })],
  });

  expect(prepared.contents).toEqual([
    oldModel,
    oldResponse,
    body.contents[2],
    {
      role: "model",
      parts: [
        {
          functionCall: { name: "weather", args: { city: "current" } },
          thoughtSignature: SIGNATURE,
        },
      ],
    },
    currentResponse,
  ]);
});

test("prefers an exact function-call ID over same-name response history", () => {
  const oldResponse = {
    role: "user",
    parts: [{ functionResponse: { id: "old", name: "weather", response: {} } }],
  };
  const currentResponse = {
    role: "user",
    parts: [{ functionResponse: { id: "current", name: "weather", response: {} } }],
  };
  const body = { contents: [oldResponse, { role: "user", parts: [{ text: "again" }] }, currentResponse] };

  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: [replayCall({ id: "current", name: "weather", args: {} })],
  });

  expect(prepared.contents[2]).toEqual({
    role: "model",
    parts: [
      {
        functionCall: { id: "current", name: "weather", args: {} },
        thoughtSignature: SIGNATURE,
      },
    ],
  });
});

test("does not associate an old model function call across an ordinary user turn", () => {
  const call = { id: "call-1", name: "weather", args: {} };
  const oldModel = { role: "model", parts: [{ functionCall: call }] };
  const ordinaryUserTurn = { role: "user", parts: [{ text: "start a new request" }] };
  const response = {
    role: "user",
    parts: [{ functionResponse: { id: "call-1", name: "weather", response: {} } }],
  };
  const body = { contents: [oldModel, ordinaryUserTurn, response] };

  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: [
      {
        type: "function-call",
        contentIndex: 0,
        partIndex: 0,
        call,
        signature: SIGNATURE,
      },
    ],
  });

  expect(prepared.contents).toEqual([
    oldModel,
    ordinaryUserTurn,
    { role: "model", parts: [{ functionCall: call, thoughtSignature: SIGNATURE }] },
    response,
  ]);
});

function replayCall(call: unknown) {
  return {
    type: "function-call" as const,
    contentIndex: 0,
    partIndex: 0,
    call,
    signature: SIGNATURE,
  };
}
