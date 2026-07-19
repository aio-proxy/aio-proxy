import { expect, test } from "bun:test";
import plugin, { XAI_GROK_PLUGIN_VERSION } from "./dist/index.js";

test("built artifact exports the xAI Grok descriptor", () => {
  expect(plugin.apiVersion).toBe(1);
  expect(XAI_GROK_PLUGIN_VERSION).toBe("0.0.0");
});
