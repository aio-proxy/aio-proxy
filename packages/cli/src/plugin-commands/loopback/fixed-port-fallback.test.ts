import { afterEach, describe, expect, test } from "bun:test";
import { LoopbackPortUnavailableError, runLoopbackAuthorization } from "./index";
import { createDeps, request, resetInteractive, setInteractive } from "./test-support";

afterEach(resetInteractive);

describe("fixed-port manual-only fallback", () => {
  test("continues with manual callback after explicit confirmation", async () => {
    setInteractive(true);
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    try {
      const redirectUri = `http://localhost:${occupied.port}/auth/callback`;
      const authorizationUrl = "https://identity.example/authorize?flow=manual-only";
      const created = createDeps({
        confirmManualOnly: async (candidate) => {
          expect(candidate).toBe(redirectUri);
          return true;
        },
        readManualCallbackUrl: async (candidate) => {
          expect(candidate).toBe(authorizationUrl);
          return `${redirectUri}?code=manual-only-code&state=expected-state`;
        },
      });

      await expect(
        runLoopbackAuthorization(
          request({
            redirect: { hostname: "localhost", port: occupied.port, path: "/auth/callback" },
            allowManualCallbackUrl: true,
            authorizationUrl: ({ redirectUri: candidate }) => {
              expect(candidate).toBe(redirectUri);
              return authorizationUrl;
            },
          }),
          created.deps,
        ),
      ).resolves.toEqual({ code: "manual-only-code", redirectUri });
      expect(created.opened).toEqual([authorizationUrl]);
    } finally {
      await occupied.stop(true);
    }
  });

  test("remains terminal when manual-only fallback is rejected", async () => {
    setInteractive(true);
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    try {
      let confirmed = false;
      const created = createDeps({
        confirmManualOnly: async () => {
          confirmed = true;
          return false;
        },
      });
      await expect(
        runLoopbackAuthorization(
          request({
            redirect: { hostname: "localhost", port: occupied.port, path: "/auth/callback" },
            allowManualCallbackUrl: true,
          }),
          created.deps,
        ),
      ).rejects.toBeInstanceOf(LoopbackPortUnavailableError);
      expect(confirmed).toBe(true);
      expect(created.opened).toEqual([]);
    } finally {
      await occupied.stop(true);
    }
  });
});
