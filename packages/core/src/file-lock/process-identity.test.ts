import { expect, spyOn, test } from "bun:test";

import { processIsAlive } from "./process-identity";

test.serial("processIsAlive probes Windows PIDs for npm lock semantics", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("missing"), { code: "ESRCH" });
  });
  try {
    expect(processIsAlive(999_999)).toBe(false);
    expect(kill).toHaveBeenCalledWith(999_999, 0);
  } finally {
    kill.mockRestore();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test.serial("processIsAlive rethrows non-Error process.kill failures", () => {
  const failure = Symbol("kill-failure");
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw failure;
  });
  try {
    let thrown: unknown;
    try {
      processIsAlive(999_999);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  } finally {
    kill.mockRestore();
  }
});
