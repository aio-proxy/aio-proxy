import { expect, test } from "bun:test";

import type { ProtocolErrorMapper } from "./adapter";

import { ImageInputUnsupportedError } from "../error";
import {
  anthropicMessagesErrors,
  geminiGenerateContentErrors,
  openAICompletionsErrors,
  openAIResponsesErrors,
} from "./errors";
import { InvalidCompressedRequestBodyError } from "./request";

const cases = [
  [
    "OpenAI Chat Completions",
    openAICompletionsErrors,
    {
      error: {
        code: "unsupported_content_encoding",
        message: "Unsupported Content-Encoding",
        type: "invalid_request_error",
      },
    },
    {
      error: { code: "invalid_request", message: "Invalid OpenAI Completions request", type: "invalid_request_error" },
    },
  ],
  [
    "OpenAI Responses",
    openAIResponsesErrors,
    {
      error: {
        code: "unsupported_content_encoding",
        message: "Unsupported Content-Encoding",
        type: "invalid_request_error",
      },
    },
    { error: { code: "invalid_request", message: "Invalid OpenAI Responses request", type: "invalid_request_error" } },
  ],
  [
    "Anthropic Messages",
    anthropicMessagesErrors,
    { type: "error", error: { type: "invalid_request_error", message: "Unsupported Content-Encoding" } },
    { type: "error", error: { type: "invalid_request_error", message: "Invalid Anthropic Messages request" } },
  ],
  [
    "Gemini generateContent",
    geminiGenerateContentErrors,
    { error: { code: 415, message: "Unsupported Content-Encoding", status: "INVALID_ARGUMENT" } },
    { error: { code: 400, message: "Invalid Gemini request", status: "INVALID_ARGUMENT" } },
  ],
] as const satisfies readonly (readonly [string, ProtocolErrorMapper, unknown, unknown])[];

test.each(cases)("maps unsupported content encoding for %s", async (_name, mapper, expected) => {
  const response = mapper.unsupportedContentEncoding();

  expect(response.status).toBe(415);
  expect(await response.json()).toEqual(expected);
  expect(JSON.stringify(expected)).not.toContain("secret-marker");
});

test.each(cases)("maps invalid compressed bodies for %s", async (_name, mapper, _unsupported, expected) => {
  const response = mapper.requestError(new InvalidCompressedRequestBodyError("native decoder detail"));

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual(expected);
  expect(JSON.stringify(expected)).not.toContain("native decoder detail");
});

test("maps image compatibility errors into every inbound protocol shape", async () => {
  const error = new ImageInputUnsupportedError("gemini-tool-url", "messages.2.content.0.output.value.1");
  const cases = [
    [openAICompletionsErrors, 501, "unsupported_feature"],
    [openAIResponsesErrors, 501, "unsupported_feature"],
    [anthropicMessagesErrors, 501, "invalid_request_error"],
    [geminiGenerateContentErrors, 501, "UNIMPLEMENTED"],
  ] as const;

  for (const [mapper, status, marker] of cases) {
    const response = mapper.modelUnsupported?.(error);
    expect(response?.status).toBe(status);
    const body = await response?.text();
    expect(body).toContain(marker);
    expect(body).not.toContain("https://");
    expect(body).not.toContain("file_");
  }
});
