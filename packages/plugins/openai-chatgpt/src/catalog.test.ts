import { afterEach, expect, test } from "bun:test";

import { CHATGPT_CATALOG_TTL_MS, discoverOpenAIChatGPTModels } from "./catalog";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("keeps supported visible and hidden Codex models in priority order", async () => {
  globalThis.fetch = async () =>
    Response.json({
      models: [
        { slug: "hidden", display_name: "Hidden", priority: 2, supported_in_api: true, visibility: "hide" },
        { slug: "unsupported", display_name: "Unsupported", priority: 0, supported_in_api: false, visibility: "list" },
        { slug: "visible", display_name: "Visible", priority: 1, supported_in_api: true, visibility: "list" },
      ],
    });

  await expect(discoverOpenAIChatGPTModels(new AbortController().signal)).resolves.toEqual([
    { id: "visible", displayName: "Visible" },
    { id: "hidden", displayName: "Hidden" },
  ]);
  expect(CHATGPT_CATALOG_TTL_MS).toBe(6 * 60 * 60_000);
});
