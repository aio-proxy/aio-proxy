import { afterEach, describe, expect, test } from "bun:test";
import { REQUEST_BODY_LIMITS } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import { createTempHomes, recorded } from "../../_test/openai-responses.test-support";
import { createServer } from "../server";
import type { ServerLog } from "../server-log";

const homes = createTempHomes("aio-proxy-responses-early-logs-");
afterEach(homes.cleanup);

const cases = [
  {
    name: "malformed JSON",
    body: "{",
    statusCode: 400,
    requestedModelId: "<unparsed>",
    errorCode: "invalid_request",
    errorType: "SyntaxError",
  },
  {
    name: "oversized Content-Length",
    body: "{}",
    contentLength: String(REQUEST_BODY_LIMITS.encoded + 1),
    statusCode: 413,
    requestedModelId: "<unparsed>",
    errorCode: "request_too_large",
    errorType: "RequestBodyTooLargeError",
  },
  {
    name: "missing model route",
    body: JSON.stringify({ model: "missing", input: "hello" }),
    statusCode: 404,
    requestedModelId: "missing",
    errorCode: "model_not_found",
    errorType: "RouterModelNotFoundError",
  },
] as const;

describe("OpenAI Responses early request observability", () => {
  for (const scenario of cases) {
    test(`records and logs ${scenario.name} before any provider attempt`, async () => {
      const logs: ServerLog[] = [];
      const dbHome = homes.tempHome();
      const app = await createServer({
        config: { providers: {} },
        dbHome,
        logger: (entry) => logs.push(entry),
      });

      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...("contentLength" in scenario ? { "content-length": scenario.contentLength } : {}),
        },
        body: scenario.body,
      });
      const stored = await recorded(dbHome);
      const row = stored.requests[0];

      expect(response.status).toBe(scenario.statusCode);
      expect(stored).toEqual({
        requests: [
          expect.objectContaining({
            inboundProtocol: ProviderProtocol.OpenAIResponse,
            requestedModelId: scenario.requestedModelId,
            outcome: "failure",
            finalStatusCode: scenario.statusCode,
            errorCode: scenario.errorCode,
            attempts: [],
          }),
        ],
        usages: [],
      });
      expect(logs).toEqual([
        {
          event: "request.rejected",
          requestId: row?.requestId,
          inboundProtocol: ProviderProtocol.OpenAIResponse,
          ...(scenario.requestedModelId === "<unparsed>" ? {} : { requestedModelId: scenario.requestedModelId }),
          path: "/v1/responses",
          statusCode: scenario.statusCode,
          errorCode: scenario.errorCode,
          errorType: scenario.errorType,
        },
      ]);
    });
  }
});
