import { expect, test } from "bun:test";

import { createFifoQueue } from "../src/fifo-queue";

test("FIFO queue preserves invocation order and a rejection does not poison later work", async () => {
  const enqueue = createFifoQueue();
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];
  const first = enqueue(async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
    throw new Error("first failed");
  });
  const second = enqueue(async () => {
    order.push("second");
    return "ok";
  });

  await Bun.sleep(0);
  expect(order).toEqual(["first:start"]);
  releaseFirst();
  await expect(first).rejects.toThrow("first failed");
  expect(await second).toBe("ok");
  expect(order).toEqual(["first:start", "first:end", "second"]);
});
