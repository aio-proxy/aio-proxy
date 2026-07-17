import { afterAll, describe, expect, test } from "bun:test";
import { createDashboardProviderFixture } from "./dashboard-providers-mutation.test-support";

const { cleanup, onDisk, req } = await createDashboardProviderFixture("aio-dashboard-provider-concurrency-");

afterAll(cleanup);

describe("dashboard provider CRUD", () => {
  test("27. concurrent POST requests for one id allow exactly one create", async () => {
    const [first, second] = await Promise.all([
      req("POST", "/providers", {
        kind: "api",
        id: "race-create",
        protocol: "openai-compatible",
        baseURL: "https://first.example.com",
      }),
      req("POST", "/providers", {
        kind: "api",
        id: "race-create",
        protocol: "openai-compatible",
        baseURL: "https://second.example.com",
      }),
    ]);

    expect([first.status, second.status].toSorted()).toEqual([201, 409]);
  });

  test("28. concurrent DELETE then PUT does not recreate the deleted provider", async () => {
    const create = await req("POST", "/providers", {
      kind: "api",
      id: "race-update",
      protocol: "openai-compatible",
      baseURL: "https://before.example.com",
    });
    expect(create.status).toBe(201);

    const [removed, updated] = await Promise.all([
      req("DELETE", "/providers/race-update"),
      req("PUT", "/providers/race-update", {
        kind: "api",
        id: "race-update",
        protocol: "openai-compatible",
        baseURL: "https://after.example.com",
      }),
    ]);

    expect(removed.status).toBe(200);
    expect(updated.status).toBe(404);
    expect(onDisk().providers["race-update"]).toBeUndefined();
  });

  test("29. POST ai-sdk provider with a blank packageName returns 400 without writing it", async () => {
    // Given
    const id = "blank-package";

    // When
    const response = await req("POST", "/providers", {
      kind: "ai-sdk",
      id,
      packageName: "   ",
    });

    // Then
    expect(response.status).toBe(400);
    expect(onDisk().providers[id]).toBeUndefined();
  });
});
