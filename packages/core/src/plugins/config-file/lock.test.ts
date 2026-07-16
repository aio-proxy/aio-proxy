import { expect, test } from "bun:test";
import { CONFIG_LOCK_HEARTBEAT_MS, CONFIG_LOCK_STALE_MS, CONFIG_LOCK_WAIT_MS } from "./lock";
import "./lock-abandoned-cases";
import "./lock-core-cases";
import "./lock-fencing-cases";
import "./lock-identity-cases";

test("preserves config lock timing constants", () => {
  expect([CONFIG_LOCK_WAIT_MS, CONFIG_LOCK_STALE_MS, CONFIG_LOCK_HEARTBEAT_MS]).toEqual([15_000, 60_000, 10_000]);
});
