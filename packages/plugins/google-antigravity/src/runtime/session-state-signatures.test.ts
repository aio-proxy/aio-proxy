import { expect, test } from "bun:test";

import { prepareReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "signature-".repeat(6);
const THOUGHT_SIGNATURE = "thought-signature-".repeat(4);

test("signs an existing unsigned model turn without duplicating its function call", () => {
  const body = {
    contents: [
      {
        role: "model",
        parts: [
          { text: "reasoning", thought: true },
          { functionCall: { id: "call-1", name: "weather", args: { city: "Shanghai" } } },
        ],
      },
      { role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: { ok: true } } }] },
    ],
  };

  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: [
      { type: "thought-signature", contentIndex: 8, partIndex: 2, signature: SIGNATURE },
      {
        type: "function-call",
        contentIndex: 8,
        partIndex: 5,
        call: { args: { city: "Shanghai" }, name: "weather", id: "call-1" },
        signature: SIGNATURE,
      },
    ],
  });

  expect(prepared.contents[0]).toEqual({
    role: "model",
    parts: [
      { text: "reasoning", thought: true, thoughtSignature: SIGNATURE },
      {
        functionCall: { id: "call-1", name: "weather", args: { city: "Shanghai" } },
        thoughtSignature: SIGNATURE,
      },
    ],
  });
});

test("does not duplicate an equivalent signed model call", () => {
  const modelTurn = {
    role: "model",
    parts: [{ functionCall: { id: "call-1", name: "weather", args: {} }, thoughtSignature: SIGNATURE }],
  };
  const body = {
    contents: [
      modelTurn,
      { role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: {} } }] },
    ],
  };

  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: [
      {
        type: "function-call",
        contentIndex: 0,
        partIndex: 0,
        call: { id: "call-1", name: "weather", args: {} },
        signature: SIGNATURE,
      },
    ],
  });

  expect(prepared.contents).toEqual(body.contents);
});

test("signs an unsigned thought even when the matching function call is already signed", () => {
  const call = { id: "call-1", name: "weather", args: {} };
  const response = { role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: {} } }] };
  const body = {
    contents: [
      {
        role: "model",
        parts: [
          { text: "reasoning", thought: true },
          { functionCall: call, thoughtSignature: SIGNATURE },
        ],
      },
      response,
    ],
  };

  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: [
      { type: "thought-signature", contentIndex: 0, partIndex: 0, signature: THOUGHT_SIGNATURE },
      { type: "function-call", contentIndex: 0, partIndex: 1, call, signature: SIGNATURE },
    ],
  });

  expect(prepared.contents[0]).toEqual({
    role: "model",
    parts: [
      { text: "reasoning", thought: true, thoughtSignature: THOUGHT_SIGNATURE },
      { functionCall: call, thoughtSignature: SIGNATURE },
    ],
  });
});

test("retains a valid signed duplicate when the replayed call is unsigned", () => {
  const call = { id: "call-1", name: "weather", args: {} };
  const signed = {
    functionCall: call,
    thoughtSignature: SIGNATURE,
    providerMetadata: { google: { retained: true } },
  };
  const prepared = prepareCallDuplicates([{ functionCall: call }, signed], call);
  const model = prepared.contents[0] as { readonly parts: readonly unknown[] };

  expect(model.parts).toEqual([signed]);
});

test("prefers the valid signed duplicate and its metadata among multiple matches", () => {
  const call = { id: "call-1", name: "weather", args: {} };
  const signed = {
    functionCall: call,
    thoughtSignature: SIGNATURE,
    providerMetadata: { google: { retained: "best-signed-match" } },
  };
  const prepared = prepareCallDuplicates(
    [
      { functionCall: call, thoughtSignature: "invalid", providerMetadata: { google: { retained: false } } },
      { functionCall: call },
      signed,
    ],
    call,
  );
  const model = prepared.contents[0] as { readonly parts: readonly unknown[] };

  expect(model.parts).toEqual([signed]);
});

test("does not prefer an invalid signature over an unsigned duplicate", () => {
  const call = { id: "call-1", name: "weather", args: {} };
  const unsigned = { functionCall: call, providerMetadata: { google: { retained: "unsigned" } } };
  const prepared = prepareCallDuplicates(
    [{ functionCall: call, thoughtSignature: "invalid", providerMetadata: { google: { retained: false } } }, unsigned],
    call,
  );
  const model = prepared.contents[0] as { readonly parts: readonly unknown[] };

  expect(model.parts).toEqual([unsigned]);
});

function prepareCallDuplicates(parts: readonly unknown[], call: { readonly id: string; readonly name: string }) {
  return prepareReasoningReplay(
    {
      contents: [
        { role: "model", parts },
        { role: "user", parts: [{ functionResponse: { id: call.id, name: call.name, response: {} } }] },
      ],
    },
    MODEL,
    {
      parts: [
        {
          type: "function-call",
          contentIndex: 0,
          partIndex: 0,
          call,
          signature: undefined,
        },
      ],
    },
  );
}
