import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import { bridgeApiProviderToAiSdk } from "../../index";

test.each([
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
] as const)("publishes %s as the API bridge image target", (protocol) => {
  const bridge = bridgeApiProviderToAiSdk({
    kind: ProviderKind.Api,
    id: `provider-${protocol}`,
    protocol,
    baseURL: "https://api.example.test/v1",
    models: ["model"],
  });

  expect(bridge?.targetProtocol).toBe(protocol);
});
