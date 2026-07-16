import { describe, expect, test } from "bun:test";
import { browserCommand } from "../src/open-browser";

describe("browser command", () => {
  test("passes a Windows OAuth URL containing state as one quoted argument", () => {
    const url = "https://identity.example/authorize?client_id=a&state=secret-state";

    const command = browserCommand(url, "win32");

    expect(command).toEqual({
      bin: "cmd",
      args: ["/d", "/s", "/c", "start", '""', `"${url}"`],
    });
    expect(command.args.filter((argument) => argument.includes("state="))).toEqual([`"${url}"`]);
  });
});
