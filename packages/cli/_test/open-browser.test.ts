import { describe, expect, test } from "bun:test";

import { createOpenBrowser } from "../src/open-browser";

describe("open browser", () => {
  test("spawns the Windows browser command with the OAuth URL as one argument", () => {
    const url = "https://identity.example/authorize?client_id=a&state=secret-state";
    const calls: unknown[][] = [];
    let unrefs = 0;
    const openBrowser = createOpenBrowser({
      platform: "win32",
      spawn: (...args: unknown[]) => {
        calls.push(args);
        return {
          unref() {
            unrefs += 1;
          },
        };
      },
    });

    const opened = openBrowser(url);

    expect(opened).toBe(true);
    expect(calls).toEqual([
      [
        "cmd",
        ["/d", "/s", "/c", "start", '""', `"${url}"`],
        {
          detached: true,
          stdio: "ignore",
          windowsVerbatimArguments: true,
        },
      ],
    ]);
    expect((calls[0]?.[1] as string[] | undefined)?.filter((argument) => argument.includes("state="))).toEqual([
      `"${url}"`,
    ]);
    expect(unrefs).toBe(1);
  });
});
