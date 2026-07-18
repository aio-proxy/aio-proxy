import { expect, test } from "bun:test";
import { antigravityEndpoints } from "../runtime/endpoints";
import { initializeAntigravityProject } from "./project";

test("routes load to prod, onboarding to daily, and runtime operations through both defaults", () => {
  expect(antigravityEndpoints({}, "project-load")).toEqual(["https://cloudcode-pa.googleapis.com"]);
  expect(antigravityEndpoints({}, "onboarding")).toEqual(["https://daily-cloudcode-pa.googleapis.com"]);
  expect(antigravityEndpoints({}, "discovery")).toEqual([
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]);
  expect(antigravityEndpoints({ baseURL: " https://proxy.example.test/root/ " }, "inference")).toEqual([
    "https://proxy.example.test/root",
  ]);
});

test.each([
  "https://proxy.example.test/root?tenant=secret",
  "https://proxy.example.test/root#fragment",
])("does not construct fixed endpoints from a base URL containing query or fragment", (baseURL) => {
  expect(() => antigravityEndpoints({ baseURL }, "discovery")).toThrow("query or fragment");
});

test("returns an existing project identity from loadCodeAssist", async () => {
  const requests: Request[] = [];
  const projectId = await initializeAntigravityProject(
    "access",
    {},
    {
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ project: { id: " project-existing " } });
      },
      sleep: async () => {},
      signal: new AbortController().signal,
    },
  );

  expect(projectId).toBe("project-existing");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
  expect(await requests[0]?.clone().json()).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
});

test("onboards with default tier and polls no more than five times", async () => {
  const requests: Request[] = [];
  const sleeps: number[] = [];
  const projectId = await initializeAntigravityProject(
    "access",
    {},
    {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith(":loadCodeAssist")) {
          return Response.json({ allowedTiers: [{ id: "preferred", isDefault: true }] });
        }
        return requests.filter((item) => item.url.endsWith(":onboardUser")).length < 3
          ? Response.json({ done: false })
          : Response.json({ done: true, response: { cloudaicompanionProject: "project-1" } });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      signal: new AbortController().signal,
    },
  );

  expect(projectId).toBe("project-1");
  expect(await requests[1]?.clone().json()).toMatchObject({
    tier_id: "preferred",
    metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity" },
  });
  expect(requests[1]?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser");
  expect(requests[1]?.headers.get("x-goog-api-client")).toBe("gl-node/22.21.1");
  expect(requests[1]?.headers.get("user-agent")).toContain("google-api-nodejs-client/10.3.0");
  expect(requests).toHaveLength(4);
  expect(sleeps).toEqual([2_000, 2_000]);
});

test("uses the current tier before falling back to free-tier", async () => {
  const tierIds: string[] = [];
  for (const loadPayload of [{ currentTier: { id: "current" } }, {}]) {
    await expect(
      initializeAntigravityProject(
        "access",
        {},
        {
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (request.url.endsWith(":loadCodeAssist")) return Response.json(loadPayload);
            tierIds.push((await request.clone().json()).tier_id);
            return Response.json({ done: true, response: { projectId: "project-1" } });
          },
          sleep: async () => {},
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe("project-1");
  }
  expect(tierIds).toEqual(["current", "free-tier"]);
});

test("stops project onboarding after five attempts", async () => {
  let onboardAttempts = 0;
  await expect(
    initializeAntigravityProject(
      "project-access-secret",
      {},
      {
        fetch: async (input) => {
          if (String(input).endsWith(":loadCodeAssist")) return Response.json({});
          onboardAttempts += 1;
          return Response.json({ done: false });
        },
        sleep: async () => {},
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toThrow("five attempts");
  expect(onboardAttempts).toBe(5);
});
