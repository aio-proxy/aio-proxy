import { expect, test } from "bun:test";
import { openAIResponsesAdapter } from "../index";

test("drops background before raw forwarding while preserving unknown fields", async () => {
  const body = Bun.gzipSync(
    new TextEncoder().encode(
      JSON.stringify({
        model: "gpt-5.6-terra",
        input: "hello",
        background: true,
        beta_field: { retain: true },
      }),
    ),
  );
  const raw = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-encoding": "gzip", "content-type": "application/json" },
    body,
  });
  const parsed = await openAIResponsesAdapter.parse(raw, {});

  const forwarded = await openAIResponsesAdapter.rawRequest(raw, parsed, "gpt-5.6-terra", {});

  expect(forwarded.headers.get("content-encoding")).toBeNull();
  expect(await forwarded.json()).toEqual({
    model: "gpt-5.6-terra",
    input: "hello",
    beta_field: { retain: true },
  });
});

test("reports a safe diagnostic when background mode is downgraded", async () => {
  const raw = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-terra", input: "hello", background: true }),
  });
  const parsed = await openAIResponsesAdapter.parse(raw, {});

  expect(openAIResponsesAdapter.requestDiagnostics(parsed, {})).toEqual([
    { feature: "background", action: "dropped", effectiveMode: "synchronous" },
  ]);
});
