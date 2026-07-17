import { afterAll, describe, expect, test } from "bun:test";
import { createDashboardProviderFixture } from "./dashboard-providers-mutation.test-support";

const decoder = new TextDecoder();
const fixture = await createDashboardProviderFixture("aio-dashboard-provider-basic-");
const { cleanup, onDisk, req, requestPathless, requestPathlessProviders } = fixture;
const postProvider = (body: unknown) => req("POST", "/providers", body);

async function readNextEventText(stream: Response, timeoutMs = 2_000): Promise<string> {
  const reader = stream.body?.getReader();
  if (reader === undefined) {
    throw new Error("dashboard event stream body is missing");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out waiting for dashboard event")), timeoutMs);
  });
  try {
    const chunk = await Promise.race([reader.read(), deadline]);
    return chunk.done ? "" : decoder.decode(chunk.value);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel();
  }
}

afterAll(cleanup);

describe("dashboard provider CRUD", () => {
  test("1. GET /providers list carries clientModels and hasApiKey fields", async () => {
    const res = await req("GET", "/providers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers[0]).toHaveProperty("clientModels");
    const api = body.providers.find((provider: { id: string }) => provider.id === "seed-api");
    expect(api).toHaveProperty("clientModels");
    expect(api.hasApiKey).toBe(true);
  });

  test("2. POST new api provider returns 201 and writes it to disk", async () => {
    const res = await req("POST", "/providers", {
      kind: "api",
      id: "newapi",
      protocol: "openai-compatible",
      baseURL: "https://newapi.example.com",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider.id).toBe("newapi");
    expect(body.provider.kind).toBe("api");
    expect(onDisk().providers.newapi).toBeDefined();
  });

  test("3. POST duplicate id returns 409", async () => {
    const res = await req("POST", "/providers", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://dup.example.com",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("provider id already exists");
  });

  test("4. POST oauth kind returns 400 (mutation union omits oauth)", async () => {
    const res = await req("POST", "/providers", {
      kind: "oauth",
      id: "newoauth",
      vendor: "legacy-provider",
    });
    expect(res.status).toBe(400);
  });

  test("POST malformed body missing baseURL returns 400 with zod details", async () => {
    const response = await postProvider({
      kind: "api",
      id: "missing-base-url",
      protocol: "openai-compatible",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(
      body.details.some((issue: { path: unknown[] }) => Array.isArray(issue.path) && issue.path.includes("baseURL")),
    ).toBe(true);
  });

  test("POST rejects removed baseUrl spelling", async () => {
    const response = await postProvider({
      kind: "api",
      id: "legacy-spelling",
      protocol: "openai-compatible",
      baseUrl: "https://api.example.com",
    });
    expect(response.status).toBe(400);
  });

  test("6. PUT rename attempt (body.id !== :id) returns 400", async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "renamed",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("provider rename not supported");
  });

  test("7. PUT with apiKey omitted preserves the stored key", async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers["seed-api"].apiKey).toBe("sk-preserved-value");
  });

  test('8. PUT with apiKey: "" preserves the stored key', async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
      apiKey: "",
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers["seed-api"].apiKey).toBe("sk-preserved-value");
  });

  test("9. PUT with a new apiKey writes the new value", async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
      apiKey: "sk-new-value",
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers["seed-api"].apiKey).toBe("sk-new-value");
  });

  test("10. PUT nonexistent provider returns 404", async () => {
    const res = await req("PUT", "/providers/ghost", {
      kind: "api",
      id: "ghost",
      protocol: "openai-response",
      baseURL: "https://ghost.example.com",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("provider not found");
  });

  test("11. DELETE seed-oauth removes it from disk", async () => {
    const res = await req("DELETE", "/providers/seed-oauth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: "seed-oauth" });
    expect(onDisk().providers["seed-oauth"]).toBeUndefined();
  });

  test("12. DELETE nonexistent provider returns 404", async () => {
    const res = await req("DELETE", "/providers/ghost");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("provider not found");
  });

  test("13. GET edit-view returns hasApiKey:true and no apiKey field", async () => {
    const res = await req("GET", "/providers/seed-api/edit-view");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider.hasApiKey).toBe(true);
    expect(body.provider).not.toHaveProperty("apiKey");
  });

  test("14. SSE config.changed fires after POST", async () => {
    const stream = await req("GET", "/events");
    expect(stream.status).toBe(200);
    const post = await req("POST", "/providers", {
      kind: "api",
      id: "sseapi",
      protocol: "openai-compatible",
      baseURL: "https://sse.example.com",
    });
    expect(post.status).toBe(201);
    const text = await readNextEventText(stream);
    expect(text).toContain("event: config.changed");
  });

  test("15. POST without a configured config path returns 409", async () => {
    const res = await requestPathless({
      kind: "api",
      id: "nopath",
      protocol: "openai-response",
      baseURL: "https://nopath.example.com",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("config file path is not configured");

    const priorMutationProbe = await requestPathless({
      kind: "api",
      id: "newapi",
      protocol: "openai-compatible",
      baseURL: "https://newapi.example.com",
    });
    expect(priorMutationProbe.status).toBe(409);
    expect((await priorMutationProbe.json()).error).toBe("config file path is not configured");

    Object.assign(fixture.config.providers, {
      "leak-probe": {
        kind: "api",
        protocol: "openai-compatible",
        baseURL: "https://leak.example.com",
      },
    });
    const pathlessProviders = await requestPathlessProviders();
    const pathlessBody = await pathlessProviders.json();
    expect(pathlessBody.providers.some((provider: { id: string }) => provider.id === "leak-probe")).toBe(false);
  });
});
