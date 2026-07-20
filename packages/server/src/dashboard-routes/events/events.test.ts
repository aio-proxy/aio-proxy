import { createServer } from "@aio-proxy/server";
import { expect, test } from "bun:test";

import { loopbackServer } from "../../dashboard-auth/test-support";

test("Given slow Dashboard event consumer When queue overflows Then dropped event is emitted and stream closes", async () => {
  const app = await createServer({
    config: { providers: {} },
    eventLimits: { maxEvents: 1, maxBytes: 1_024 },
  });
  const stream = await app.request("/dashboard/api/events", undefined, loopbackServer);

  await app.request(
    "/dashboard/api/reload",
    {
      headers: { Origin: "http://127.0.0.1:22078" },
      method: "POST",
    },
    loopbackServer,
  );
  await app.request(
    "/dashboard/api/reload",
    {
      headers: { Origin: "http://127.0.0.1:22078" },
      method: "POST",
    },
    loopbackServer,
  );
  const text = await stream.text();

  expect(stream.status).toBe(200);
  expect(text).toContain("event: events.dropped");
  expect(text).toContain('"queuedEvents":1');
});
