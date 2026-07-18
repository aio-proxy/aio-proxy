import { describe, expect, test } from "bun:test";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import type { GoogleAntigravityCredential } from "../schema";
import { createCcaEnvelope, wireSessionId } from "./envelope";

describe("CCA envelope identity", () => {
  test("derives a stable negative decimal wire session and agent request id", () => {
    const input = {
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      context: logicalContext("00000000-0000-4000-8000-000000000001", "sha256:abc"),
      credential: credentialFixture(),
      modelId: "gemini-3-flash-agent",
      requestType: "agent" as const,
    };

    const envelope = createCcaEnvelope(input);
    expect(envelope.requestId).toBe("agent-00000000-0000-4000-8000-000000000001");
    expect(envelope.request.sessionId).toMatch(/^-[1-9][0-9]*$/u);
    expect(createCcaEnvelope(input).request.sessionId).toBe(envelope.request.sessionId);
    expect(wireSessionId("sha256:def")).not.toBe(envelope.request.sessionId);
  });

  test("cleans Gemini-only fields, preserves inline data, and applies the wire profile", () => {
    const inlineData = { mimeType: "image/png", data: "image-base64-marker" };
    const body = {
      contents: [{ role: "user", parts: [{ inlineData }] }],
      safetySettings: [{ category: "unsafe-marker" }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { temperature: 0.4, maxOutputTokens: 99_999 },
    };

    const envelope = createCcaEnvelope({
      body,
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: "gemini-3-flash-agent",
      requestType: "agent",
    });

    expect(envelope).toMatchObject({
      model: "gemini-3-flash-agent",
      project: "project-1",
      userAgent: "antigravity",
      requestType: "agent",
      request: {
        contents: [{ role: "user", parts: [{ inlineData }] }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        generationConfig: { temperature: 0.4, maxOutputTokens: 65_536 },
        labels: { model_enum: "MODEL_PLACEHOLDER_M132" },
      },
    });
    expect(envelope.request).not.toHaveProperty("safetySettings");
    expect(body).toHaveProperty("safetySettings");
  });

  test("never increases a lower explicit output limit", () => {
    const envelope = createCcaEnvelope({
      body: { generationConfig: { maxOutputTokens: 512 } },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: "gemini-pro-agent",
      requestType: "agent",
    });

    expect(envelope.request.generationConfig).toEqual({ maxOutputTokens: 512 });
    expect(envelope.request.labels).toEqual({ model_enum: "MODEL_PLACEHOLDER_M16" });
  });

  test("normalizes declaration domains and enables validated tools only for Claude wire models", () => {
    const body = {
      tools: [
        { functionDeclarations: [] },
        {
          functionDeclarations: [
            { name: "weather", parametersJsonSchema: { type: "object", properties: { days: { const: 3 } } } },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    };

    const envelope = createCcaEnvelope({
      body,
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: "claude-sonnet-4-6",
      requestType: "agent",
    });

    expect(body.tools).toHaveLength(2);
    expect(envelope.request).toMatchObject({
      tools: [
        {
          functionDeclarations: [
            {
              name: "weather",
              parameters: {
                type: "object",
                properties: { days: { type: "string", enum: ["3"] } },
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
    });
    expect(JSON.stringify(envelope.request)).not.toContain("parametersJsonSchema");
  });
});

function logicalContext(
  requestId = "00000000-0000-4000-8000-000000000001",
  key: `sha256:${string}` = "sha256:abc",
): LogicalRequestContext {
  return { requestId, session: { key, source: "transcript" } };
}

function credentialFixture(): GoogleAntigravityCredential {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_900_000_000_000,
    email: "person@example.com",
    projectId: "project-1",
  };
}
