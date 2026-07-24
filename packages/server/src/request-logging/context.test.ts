import { expect, test } from "bun:test";

import { currentDebugRequestLogScope, currentRequestLogContext, withAttemptLogContext, withRequestLogContext } from ".";

test("request contexts isolate promise continuations and stream callbacks", async () => {
  const seen = await Promise.all(
    ["request-a", "request-b"].map((requestId, attemptIndex) =>
      withRequestLogContext({ requestId, debug: false, logger: () => {} }, async () => {
        await Promise.resolve();
        return await withAttemptLogContext(
          { attemptIndex, providerId: `provider-${attemptIndex}`, modelId: `model-${attemptIndex}` },
          async () => {
            const stream = new ReadableStream<string>({
              start(controller) {
                queueMicrotask(() => {
                  controller.enqueue(JSON.stringify(currentRequestLogContext()));
                  controller.close();
                });
              },
            });
            return JSON.parse(await new Response(stream).text());
          },
        );
      }),
    ),
  );

  expect(seen).toEqual([
    { requestId: "request-a", attemptIndex: 0, providerId: "provider-0", modelId: "model-0" },
    { requestId: "request-b", attemptIndex: 1, providerId: "provider-1", modelId: "model-1" },
  ]);
  expect(currentRequestLogContext()).toBeUndefined();
});

test("nested attempts restore their parent context", async () => {
  await withRequestLogContext({ requestId: "request", debug: false, logger: () => {} }, async () => {
    expect(currentRequestLogContext()).toEqual({ requestId: "request" });

    await withAttemptLogContext({ attemptIndex: 1, providerId: "outer", modelId: "outer-model" }, async () => {
      await withAttemptLogContext({ attemptIndex: 2, providerId: "inner", modelId: "inner-model" }, async () => {
        await Promise.resolve();
        expect(currentRequestLogContext()).toEqual({
          requestId: "request",
          attemptIndex: 2,
          providerId: "inner",
          modelId: "inner-model",
        });
      });

      expect(currentRequestLogContext()).toEqual({
        requestId: "request",
        attemptIndex: 1,
        providerId: "outer",
        modelId: "outer-model",
      });
    });

    expect(currentRequestLogContext()).toEqual({ requestId: "request" });
  });
});

test("debug scopes expose the trusted logger only when debugging is enabled", () => {
  const logger = () => {};

  withRequestLogContext({ requestId: "quiet", debug: false, logger }, () => {
    expect(currentDebugRequestLogScope()).toBeUndefined();
  });
  withRequestLogContext({ requestId: "debug", debug: true, logger }, () => {
    expect(currentDebugRequestLogScope()).toEqual({ requestId: "debug", debug: true, logger });
  });

  expect(currentDebugRequestLogScope()).toBeUndefined();
});
