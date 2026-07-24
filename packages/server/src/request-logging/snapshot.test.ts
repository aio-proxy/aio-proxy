import { expect, test } from "bun:test";

import { snapshotRequest, snapshotResponse } from "./snapshot";

const SHA256 = /^[0-9a-f]{64}$/u;
const ONE_MIB = 1024 * 1024;

test("request snapshots retain protocol controls without exposing credentials or payloads", async () => {
  const sentinels = {
    query: "query-sentinel",
    authorization: "authorization-sentinel",
    unknownHeader: "unknown-header-sentinel",
    prompt: "prompt-sentinel",
    toolArguments: "tool-arguments-sentinel",
    image: "image-data-sentinel",
    encrypted: "encrypted-content-sentinel",
    credential: "credential-sentinel",
    unknownBody: "unknown-body-sentinel",
    userInfo: "userinfo-sentinel",
  } as const;
  const bodyText = JSON.stringify({
    model: "gpt-safe-control",
    stream: true,
    reasoning: { effort: "high" },
    messages: [{ role: "user", content: [{ type: "input_text", text: sentinels.prompt }] }],
    prompt: sentinels.prompt,
    tool: { arguments: sentinels.toolArguments },
    image_data: sentinels.image,
    encrypted_content: sentinels.encrypted,
    credentials: { token: sentinels.credential },
    metadata: { custom: sentinels.unknownBody },
  });
  const request = new Request(
    `https://${sentinels.userInfo}:${sentinels.userInfo}@upstream.test/v1/responses?api_key=${sentinels.query}`,
    {
      method: "POST",
      headers: {
        host: "proxy.test:22078",
        "content-type": "application/json",
        authorization: sentinels.authorization,
        "x-unknown": sentinels.unknownHeader,
        "user-agent": "u".repeat(600),
      },
      body: bodyText,
    },
  );

  const snapshot = await snapshotRequest(request);

  expect(snapshot.url).toBe("https://upstream.test/v1/responses?api_key=%5BREDACTED%5D");
  expect(snapshot.headers).toMatchObject({
    host: "proxy.test:22078",
    "content-type": "application/json",
    authorization: "[REDACTED]",
    "x-unknown": "[REDACTED]",
  });
  expect(snapshot.headers["user-agent"]).toHaveLength(512);
  expect(snapshot.body).toMatchObject({
    mediaType: "application/json",
    byteLength: new TextEncoder().encode(bodyText).byteLength,
    sha256: expect.stringMatching(SHA256),
    json: {
      model: "gpt-safe-control",
      stream: true,
      reasoning: { effort: "high" },
      messages: [
        {
          role: "user",
          content: [{ type: "input_text", text: { kind: "payload", sha256: expect.stringMatching(SHA256) } }],
        },
      ],
      prompt: { kind: "payload", sha256: expect.stringMatching(SHA256) },
      tool: { arguments: { kind: "payload", sha256: expect.stringMatching(SHA256) } },
      image_data: { kind: "payload", sha256: expect.stringMatching(SHA256) },
      encrypted_content: { kind: "payload", sha256: expect.stringMatching(SHA256) },
      credentials: { kind: "redacted", byteLength: expect.any(Number) },
      metadata: { custom: { kind: "string", sha256: expect.stringMatching(SHA256) } },
    },
  });
  const json = snapshot.body?.json;
  if (json === undefined) throw new Error("expected sanitized JSON");
  expect((json as Record<string, Record<string, unknown>>).credentials.sha256).toBeUndefined();
  const serialized = JSON.stringify(snapshot);
  for (const sentinel of Object.values(sentinels)) expect(serialized).not.toContain(sentinel);
});

test("protocol controls are retained only at structural paths across request protocols", async () => {
  const sentinels = [
    "openai-tool-model-sentinel",
    "anthropic-input-type-sentinel",
    "gemini-args-role-sentinel",
    "gemini-response-effort-sentinel",
  ];
  const bodies = [
    {
      model: "openai-model",
      stream: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "protected-text" }],
          tool_calls: [{ type: "function", function: { arguments: { model: sentinels[0] } } }],
        },
      ],
    },
    {
      model: "anthropic-model",
      stream: false,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", input: { type: sentinels[1] } }],
        },
      ],
    },
    {
      model: "gemini-model",
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { name: "lookup", args: { role: sentinels[2] } } },
            { functionResponse: { name: "lookup", response: { effort: sentinels[3] } } },
          ],
        },
      ],
    },
  ];

  const snapshots = await Promise.all(
    bodies.map((body) =>
      snapshotRequest(
        new Request("https://upstream.test/v1/model", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    ),
  );

  const serialized = JSON.stringify(snapshots);
  for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
  expect(serialized).not.toContain("protected-text");
  expect(snapshots[0]?.body?.json).toMatchObject({
    model: "openai-model",
    messages: [{ role: "assistant", content: [{ type: "text" }], tool_calls: [{ type: "function" }] }],
  });
  expect(snapshots[1]?.body?.json).toMatchObject({
    model: "anthropic-model",
    messages: [{ role: "assistant", content: [{ type: "tool_use" }] }],
  });
  expect(snapshots[2]?.body?.json).toMatchObject({ model: "gemini-model", contents: [{ role: "model" }] });
});

test("oversized request JSON keeps only exact byte metadata", async () => {
  const sentinel = "oversized-body-sentinel";
  const bodyText = JSON.stringify({ prompt: `${sentinel}${"x".repeat(ONE_MIB)}` });

  const snapshot = await snapshotRequest(
    new Request("https://upstream.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyText,
    }),
  );

  expect(snapshot.body).toMatchObject({
    mediaType: "application/json",
    byteLength: new TextEncoder().encode(bodyText).byteLength,
    sha256: expect.stringMatching(SHA256),
    omitted: "oversized",
  });
  expect(snapshot.body?.json).toBeUndefined();
  expect(JSON.stringify(snapshot)).not.toContain(sentinel);
});

test("response snapshots sanitize JSON strings", async () => {
  const sentinel = "upstream-response-message-sentinel";

  const snapshot = await snapshotResponse(
    Response.json({ type: "upstream_error", message: sentinel }, { status: 400, headers: { "x-detail": sentinel } }),
  );

  expect(snapshot).toMatchObject({
    statusCode: 400,
    headers: { "content-type": "application/json;charset=utf-8", "x-detail": "[REDACTED]" },
    body: {
      json: {
        type: "upstream_error",
        message: { kind: "string", sha256: expect.stringMatching(SHA256) },
      },
    },
  });
  expect(JSON.stringify(snapshot)).not.toContain(sentinel);
});

test("response body media types obey the retained header value cap", async () => {
  const sentinel = "media-type-sentinel";
  const contentType = `application/${"x".repeat(512)}${sentinel}`;

  const snapshot = await snapshotResponse(
    new Response("failure", { status: 400, headers: { "content-type": contentType } }),
  );

  expect(snapshot.headers["content-type"]).toHaveLength(512);
  expect(snapshot.body?.mediaType).toHaveLength(512);
  expect(JSON.stringify(snapshot)).not.toContain(sentinel);
});

test("snapshot entry points contain hostile metadata access", async () => {
  const sentinel = "metadata-accessor-sentinel";
  const hostile = (keys: readonly string[]) =>
    Object.defineProperties(
      {},
      Object.fromEntries(
        keys.map((key) => [
          key,
          {
            get() {
              throw new Error(sentinel);
            },
          },
        ]),
      ),
    );

  const request = await snapshotRequest(hostile(["method", "url", "headers", "body"]) as Request);
  const response = await snapshotResponse(hostile(["status", "headers", "body"]) as Response);

  expect(request).toEqual({
    method: "[UNREADABLE]",
    url: "[UNREADABLE]",
    headers: {},
    body: { omitted: "unreadable" },
  });
  expect(response).toEqual({ statusCode: 0, headers: {}, body: { omitted: "unreadable" } });
  expect(JSON.stringify([request, response])).not.toContain(sentinel);
});
