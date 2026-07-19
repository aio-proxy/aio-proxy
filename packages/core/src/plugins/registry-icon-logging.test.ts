import { expect, test } from "bun:test";
import { type OAuthAdapter, zod } from "@aio-proxy/plugin-sdk";
import { createPluginRegistryHost } from "./registry";

test("a throwing icon warning sink still strips the icon and commits the capability", () => {
  const host = createPluginRegistryHost(() => {
    throw new Error("warning sink failed");
  });
  const staging = host.stage("@example/icons");
  const adapter: OAuthAdapter = {
    id: "default",
    label: "Example",
    icon: "data:text/html,private-icon-payload" as never,
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error("not called");
    },
    catalog: {
      policy: { kind: "static" },
      async discover() {
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
    async createRuntime() {
      throw new Error("not called");
    },
  };

  expect(() => staging.api.oauth.register(adapter)).not.toThrow();
  staging.seal();
  staging.commit();

  expect(host.registry.resolveOAuth("@example/icons", "default")?.icon).toBeUndefined();
});
