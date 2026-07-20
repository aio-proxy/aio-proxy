import type { AppType, CreateServerOptions } from "@aio-proxy/server";

import { expect, test } from "bun:test";
import { join } from "node:path";

import { bootProxyServer } from ".";

test("configures logging completely before creating server state", async () => {
  const events: string[] = [];
  const home = "/tmp/aio-proxy-test-home";
  const config = {
    providers: {},
    server: {
      logging: {
        enabled: true,
        level: "debug",
        retentionDays: 30,
      },
    },
  };

  await bootProxyServer(
    { config },
    {
      aioHome: () => home,
      configureLogging: async (logging) => {
        events.push("configure:start");
        await Promise.resolve();
        events.push("configure:end");
        expect(logging).toEqual({
          dir: join(home, "logs"),
          enabled: true,
          level: "debug",
          retentionDays: 30,
        });
      },
      createServer: async (_options: CreateServerOptions) => {
        events.push("createServer");
        return {} as AppType;
      },
    },
  );

  expect(events).toEqual(["configure:start", "configure:end", "createServer"]);
});
