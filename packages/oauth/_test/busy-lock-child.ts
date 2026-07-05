import { openDb } from "@aio-proxy/core/db";

const holdMsArg = process.argv.at(2);
const holdMs = holdMsArg === undefined ? 1_000 : Number.parseInt(holdMsArg, 10);
const sleepBuffer = new SharedArrayBuffer(4);
const sleepView = new Int32Array(sleepBuffer);
const handle = openDb();

try {
  const holdWriteLock = handle.sqlite.transaction(() => {
    console.log("locked");
    Atomics.wait(sleepView, 0, 0, holdMs);
  });

  holdWriteLock.immediate();
} finally {
  handle.close();
}
