import { expect, test } from "bun:test";
import type { LogicalRequestContext, ProviderExecutedTool } from "@aio-proxy/plugin-sdk";
import { createAntigravityGoogleFetch } from "../runtime/google-fetch";
import type { CcaTransport } from "../runtime/transport";
import { ccaGoogleSearch } from "./web-search";

const supportedMetadata = { antigravity: { supportsWebSearch: true } };

test("rejects web search when the selected catalog descriptor does not support it", () => {
  expect(() => ccaGoogleSearch(webSearch(), { antigravity: { supportsWebSearch: false } })).toThrow(
    "does not support web search",
  );
});

test("maps max uses and allowed domains to the verified CCA googleSearch shape", () => {
  expect(
    ccaGoogleSearch(
      webSearch({
        maxUses: 8,
        allowedDomains: ["example.com"],
      }),
      supportedMetadata,
    ),
  ).toEqual({
    googleSearch: {
      enhancedContent: { imageSearch: { maxResultCount: 8 } },
      includedDomains: ["example.com"],
    },
  });
});

test("omits empty domain arrays and defaults the maximum result count", () => {
  expect(
    ccaGoogleSearch(
      webSearch({
        allowedDomains: [],
        blockedDomains: [],
      }),
      supportedMetadata,
    ),
  ).toEqual({
    googleSearch: {
      enhancedContent: { imageSearch: { maxResultCount: 5 } },
    },
  });
});

test("appends googleSearch to the CCA request and scopes blocked-domain instructions to web search", async () => {
  let bodySeen: Readonly<Record<string, unknown>> | undefined;
  const transport: CcaTransport = {
    async execute(input) {
      bodySeen = input.body;
      return Response.json({
        response: {
          candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        },
      });
    },
  };
  const fetcher = createAntigravityGoogleFetch(
    {
      context: logicalContext(),
      modelMetadata: supportedMetadata,
      providerTools: [webSearch({ blockedDomains: ["blocked.example"] })],
      transport,
    },
    "gemini-3-flash-agent",
  );

  await fetcher("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-agent:generateContent", {
    method: "POST",
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Search" }] }],
      systemInstruction: { parts: [{ text: "Existing instruction" }] },
      tools: [{ functionDeclarations: [{ name: "lookup" }] }],
    }),
  });

  expect(bodySeen?.tools).toEqual([
    { functionDeclarations: [{ name: "lookup" }] },
    {
      googleSearch: {
        enhancedContent: { imageSearch: { maxResultCount: 5 } },
      },
    },
  ]);
  expect(bodySeen?.systemInstruction).toEqual({
    parts: [
      { text: "Existing instruction" },
      { text: expect.stringContaining("Exclude results from: blocked.example") },
    ],
  });
});

test("does not add a web-search instruction without a provider-executed tool", async () => {
  let bodySeen: Readonly<Record<string, unknown>> | undefined;
  const fetcher = createAntigravityGoogleFetch(
    {
      context: logicalContext(),
      transport: {
        async execute(input) {
          bodySeen = input.body;
          return Response.json({ response: { candidates: [] } });
        },
      },
    },
    "gemini-3-flash-agent",
  );

  await fetcher("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-agent:generateContent", {
    method: "POST",
    body: JSON.stringify({ contents: [] }),
  });

  expect(bodySeen?.systemInstruction).toBeUndefined();
});

function webSearch(overrides: Partial<ProviderExecutedTool> = {}): ProviderExecutedTool {
  return { type: "web-search", name: "web_search", ...overrides };
}

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}
