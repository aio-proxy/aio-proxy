import { expect, test } from "bun:test";

import { capturedReplay, codecCalls, TEST_MODEL as MODEL } from "../../test-support/google-codec-replay";
import { prepareReasoningReplay } from "./session-state";

const SIGNATURE = "streamed-call-signature-".repeat(3);
const SECOND_SIGNATURE = "second-streamed-signature-".repeat(3);

test("captures one complete partialArgs call matching the Google 4.0.3 codec", async () => {
  const events = selfTerminatingCallEvents();
  const calls = await codecCalls(events);

  expect(calls).toEqual([{ id: "call-weather", name: "weather", args: { city: "Shanghai" } }]);
  expect((await capturedReplay(events, "codec-oracle"))?.parts).toEqual([
    {
      type: "function-call",
      contentIndex: 0,
      partIndex: 1,
      call: calls[0],
      signature: SIGNATURE,
    },
  ]);
});

test("prepares a captured streamed call into an existing model turn", async () => {
  const replay = await capturedReplay(selfTerminatingCallEvents(), "prepare-model-turn");
  const call = { id: "call-weather", name: "weather", args: { city: "Shanghai" } };
  const existing = { functionCall: call, providerMetadata: { retained: true } };
  const body = {
    contents: [
      { role: "model", parts: [existing] },
      { role: "user", parts: [{ functionResponse: { id: call.id, name: call.name, response: { ok: true } } }] },
    ],
  };

  expect(prepareReasoningReplay(body, MODEL, replay).contents[0]).toEqual({
    role: "model",
    parts: [{ ...existing, thoughtSignature: SIGNATURE }],
  });
});

test("finishes a streamed call from an empty terminal chunk", async () => {
  const events = [
    contentFrame([
      {
        functionCall: {
          id: "call-weather",
          name: "weather",
          partialArgs: [{ jsonPath: "$.city", stringValue: "Shang", willContinue: true }],
          willContinue: true,
        },
        thoughtSignature: SIGNATURE,
      },
    ]),
    contentFrame([
      {
        functionCall: {
          partialArgs: [{ jsonPath: "$.city", stringValue: "hai", willContinue: true }],
          willContinue: true,
        },
      },
    ]),
    contentFrame([{ functionCall: {} }]),
    finishFrame(),
  ];

  await expectReplayMatchesCodec(events, [{ contentIndex: 0, partIndex: 0, signature: SIGNATURE }], "empty-terminal");
});

test("normalizes a single no-args call like the Google codec", async () => {
  const events = [
    contentFrame([{ functionCall: { id: "call-no-args", name: "get_time" }, thoughtSignature: SIGNATURE }], "STOP"),
  ];

  await expectReplayMatchesCodec(events, [{ contentIndex: 0, partIndex: 0, signature: SIGNATURE }], "no-args");
});

test("keeps an ordinary complete args call unchanged", async () => {
  const events = [
    contentFrame(
      [
        {
          functionCall: { id: "call-complete", name: "weather", args: { city: "Paris" } },
          thoughtSignature: SIGNATURE,
        },
      ],
      "STOP",
    ),
  ];

  await expectReplayMatchesCodec(events, [{ contentIndex: 0, partIndex: 0, signature: SIGNATURE }], "complete-args");
});

test("accepts explicit false continuation flags and boolean partial values", async () => {
  const events = [
    contentFrame(
      [
        {
          functionCall: {
            id: "call-toggle",
            name: "toggle",
            partialArgs: [{ jsonPath: "$.enabled", boolValue: false, willContinue: false }],
            willContinue: false,
          },
          thoughtSignature: SIGNATURE,
        },
      ],
      "STOP",
    ),
  ];

  await expectReplayMatchesCodec(events, [{ contentIndex: 0, partIndex: 0, signature: SIGNATURE }], "false-values");
});

test("accumulates sequential streamed tools into one replay occurrence each", async () => {
  const events = [
    contentFrame([
      {
        functionCall: {
          id: "call-weather",
          name: "weather",
          partialArgs: [{ jsonPath: "$.city", stringValue: "Par", willContinue: true }],
          willContinue: true,
        },
        thoughtSignature: SIGNATURE,
      },
    ]),
    contentFrame([{ functionCall: { partialArgs: [{ jsonPath: "$.city", stringValue: "is" }] } }]),
    contentFrame([
      {
        functionCall: {
          id: "call-time",
          name: "get_time",
          partialArgs: [{ jsonPath: "$.zone", stringValue: "UTC" }],
        },
        thoughtSignature: SECOND_SIGNATURE,
      },
    ]),
    finishFrame(),
  ];

  await expectReplayMatchesCodec(
    events,
    [
      { contentIndex: 0, partIndex: 0, signature: SIGNATURE },
      { contentIndex: 2, partIndex: 0, signature: SECOND_SIGNATURE },
    ],
    "sequential-tools",
  );
});

test("does not replay interleaved streamed calls from multiple candidates", async () => {
  const events = [
    {
      candidates: [
        candidate(0, [streamStart("call-weather", "weather", "$.city", "Par", SIGNATURE)]),
        candidate(1, [streamStart("call-time", "get_time", "$.zone", "UT", SECOND_SIGNATURE)]),
      ],
    },
    {
      candidates: [
        candidate(0, [{ functionCall: { partialArgs: [{ jsonPath: "$.city", stringValue: "is" }] } }], "STOP"),
        candidate(1, [{ functionCall: { partialArgs: [{ jsonPath: "$.zone", stringValue: "C" }] } }], "STOP"),
      ],
    },
  ];

  expect(await capturedReplay(events, "candidate-isolation")).toBeUndefined();
});

async function expectReplayMatchesCodec(
  events: readonly Record<string, unknown>[],
  positions: readonly { contentIndex: number; partIndex: number; signature: string }[],
  marker: string,
): Promise<void> {
  const calls = await codecCalls(events);
  expect((await capturedReplay(events, marker))?.parts).toEqual(
    calls.map((call, index) => ({ type: "function-call", ...positions[index], call })),
  );
}

function selfTerminatingCallEvents(): readonly Record<string, unknown>[] {
  return [
    contentFrame([
      { text: "reasoning", thought: true },
      {
        functionCall: {
          id: "call-weather",
          name: "weather",
          partialArgs: [{ jsonPath: "$.city", stringValue: "Shang", willContinue: true }],
          willContinue: true,
        },
        thoughtSignature: SIGNATURE,
      },
    ]),
    contentFrame([{ functionCall: { partialArgs: [{ jsonPath: "$.city", stringValue: "hai" }] } }]),
    finishFrame(),
  ];
}

function contentFrame(parts: readonly unknown[], finishReason?: string): Record<string, unknown> {
  return {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts },
        ...(finishReason === undefined ? {} : { finishReason }),
      },
    ],
  };
}

function finishFrame(): Record<string, unknown> {
  return { candidates: [{ index: 0, finishReason: "STOP" }] };
}

function candidate(index: number, parts: readonly unknown[], finishReason?: string) {
  return { index, content: { role: "model", parts }, ...(finishReason === undefined ? {} : { finishReason }) };
}

function streamStart(id: string, name: string, jsonPath: string, stringValue: string, thoughtSignature: string) {
  return {
    functionCall: {
      id,
      name,
      partialArgs: [{ jsonPath, stringValue, willContinue: true }],
      willContinue: true,
    },
    thoughtSignature,
  };
}
