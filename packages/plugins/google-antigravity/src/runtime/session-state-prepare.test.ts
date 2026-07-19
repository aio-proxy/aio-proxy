import { expect, test } from "bun:test";

import { prepareReasoningReplay } from "./session-state";

const MODEL = "claude-opus-4-6-thinking";
const SIGNATURE = "signature-".repeat(6);

test("injects compact replay before a matching stateless function response", () => {
  const body = {
    contents: [
      { role: "user", parts: [{ text: "use weather" }] },
      { role: "user", parts: [{ functionResponse: { id: "call-1", name: "weather", response: { ok: true } } }] },
    ],
  };

  const prepared = prepareReasoningReplay(body, MODEL, {
    parts: [
      { type: "thought-signature", contentIndex: 9, partIndex: 4, signature: SIGNATURE },
      {
        type: "function-call",
        contentIndex: 9,
        partIndex: 8,
        call: { id: "call-1", name: "weather", args: { city: "Shanghai" } },
        signature: SIGNATURE,
      },
    ],
  });

  expect(prepared.contents).toEqual([
    body.contents[0],
    {
      role: "model",
      parts: [
        { text: "", thought: true, thoughtSignature: SIGNATURE },
        {
          functionCall: { id: "call-1", name: "weather", args: { city: "Shanghai" } },
          thoughtSignature: SIGNATURE,
        },
      ],
    },
    body.contents[1],
  ]);
});
