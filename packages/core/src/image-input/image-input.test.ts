import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import type { ModelMessage } from "../ai-sdk-bridge";

import {
  assertImageInputSupported,
  imageFilePart,
  imageTargetProtocolForPackage,
  isHttpUrl,
  isImageMediaType,
  isValidBase64,
} from ".";
import { ImageInputUnsupportedError } from "../error";

describe("imageFilePart", () => {
  test("normalizes data URLs, remote URLs, details, references, and tool markers", () => {
    expect(
      imageFilePart({ type: "url", url: "data:image/png;base64,AA==" }, { detail: "low", toolResult: true }),
    ).toEqual({
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: "AA==" },
      providerOptions: {
        openai: { imageDetail: "low" },
        aioProxy: { toolImage: true },
      },
    });
    expect(imageFilePart({ type: "url", url: "https://example.test/image.png" })).toEqual({
      type: "file",
      mediaType: "image",
      data: { type: "url", url: new URL("https://example.test/image.png") },
    });
    expect(imageFilePart({ type: "reference", provider: "openai", id: "file_123" })).toEqual({
      type: "file",
      mediaType: "image",
      data: { type: "reference", reference: { openai: "file_123" } },
    });
  });

  test("rejects malformed bytes, MIME types, data URLs, and non-HTTP URLs", () => {
    expect(isValidBase64("AA==")).toBe(true);
    expect(isValidBase64("not base64")).toBe(false);
    expect(isImageMediaType("image/webp")).toBe(true);
    expect(isImageMediaType("application/pdf")).toBe(false);
    expect(isHttpUrl("https://example.test/image.png")).toBe(true);
    expect(isHttpUrl("http:///")).toBe(false);
    expect(isHttpUrl("file:///tmp/image.png")).toBe(false);
    expect(imageFilePart({ type: "base64", mediaType: "image/png", data: "!" })).toBeUndefined();
    expect(imageFilePart({ type: "base64", mediaType: "image", data: "AA==" })).toBeUndefined();
    expect(imageFilePart({ type: "url", url: "data:image/png;base64,!" })).toBeUndefined();
    expect(imageFilePart({ type: "url", url: "ftp://example.test/image.png" })).toBeUndefined();
  });
});

describe("image compatibility preflight", () => {
  const remoteToolImage = [
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "call_1",
          toolName: "inspect",
          output: {
            type: "content" as const,
            value: [
              {
                type: "file" as const,
                mediaType: "image",
                data: { type: "url" as const, url: new URL("https://example.test/image.png") },
                providerOptions: { aioProxy: { toolImage: true } },
              },
            ],
          },
        },
      ],
    },
  ] satisfies readonly ModelMessage[];

  test("rejects remote Gemini tool images and unresolved tool targets", () => {
    expect(() => assertImageInputSupported(remoteToolImage, ProviderProtocol.Gemini)).toThrow(
      new ImageInputUnsupportedError("gemini-tool-url", "messages.0.content.0.output.value.0"),
    );
    expect(() => assertImageInputSupported(remoteToolImage, undefined)).toThrow(
      new ImageInputUnsupportedError("unknown-target", "messages.0.content.0.output.value.0"),
    );
    expect(() => assertImageInputSupported(remoteToolImage, ProviderProtocol.Anthropic)).not.toThrow();
  });

  test("allows an OpenAI user reference only on the OpenAI Responses target", () => {
    const reference = [
      {
        role: "user" as const,
        content: [
          {
            type: "file" as const,
            mediaType: "image",
            data: { type: "reference" as const, reference: { openai: "file_123" } },
          },
        ],
      },
    ] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(reference, ProviderProtocol.OpenAIResponse)).not.toThrow();
    expect(() => assertImageInputSupported(reference, ProviderProtocol.Anthropic)).toThrow(
      new ImageInputUnsupportedError("provider-reference", "messages.0.content.0"),
    );
  });

  test("maps only the four known AI SDK packages", () => {
    expect(imageTargetProtocolForPackage("@ai-sdk/openai")).toBe(ProviderProtocol.OpenAIResponse);
    expect(imageTargetProtocolForPackage("@ai-sdk/openai-compatible")).toBe(ProviderProtocol.OpenAICompatible);
    expect(imageTargetProtocolForPackage("@ai-sdk/anthropic")).toBe(ProviderProtocol.Anthropic);
    expect(imageTargetProtocolForPackage("@ai-sdk/google")).toBe(ProviderProtocol.Gemini);
    expect(imageTargetProtocolForPackage("@vendor/unknown")).toBeUndefined();
  });
});
