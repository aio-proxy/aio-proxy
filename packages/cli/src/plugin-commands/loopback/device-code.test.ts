import { describe, expect, test } from "bun:test";
import { createCliAuthorizationPort } from "../authorization";
import { AuthorizationUrlInvalidError } from "./index";
import { createDeps } from "./test-support";

describe("device-code presentation", () => {
  test("opens and always prints the complete verification URL", async () => {
    const { deps, opened, printed } = createDeps();
    await createCliAuthorizationPort(deps).presentDeviceCode({
      url: "https://identity.example/device?user_code=A%20B",
      userCode: "A B",
      instructions: "Finish in the browser.",
    });
    expect(opened).toEqual(["https://identity.example/device?user_code=A%20B"]);
    expect(printed).toEqual([
      "Copied device code.",
      "Opened authorization page.",
      "https://identity.example/device?user_code=A%20B",
      "Finish in the browser.",
    ]);
  });

  test("resolves localized device instructions at presentation time", async () => {
    const { deps, printed } = createDeps({ copyToClipboard: () => false, openBrowser: () => false });
    await createCliAuthorizationPort({ ...deps, locale: "zh-Hans" }).presentDeviceCode({
      url: "https://identity.example/device",
      userCode: "SAFE-CODE",
      instructions: { default: "Finish in browser", "zh-Hans": "请在浏览器中完成" },
    });
    expect(printed).toEqual(["Device code: SAFE-CODE", "https://identity.example/device", "请在浏览器中完成"]);
  });

  test("contains malformed, accessor-backed, and throwing runtime instructions", async () => {
    let reads = 0;
    const accessor = { default: "Default" };
    Object.defineProperty(accessor, "zh-Hans", {
      enumerable: true,
      get() {
        reads += 1;
        return "must not print";
      },
    });
    const throwing = new Proxy(
      { default: "Default" },
      {
        get() {
          throw new Error("plugin getter failure");
        },
        getOwnPropertyDescriptor() {
          throw new Error("plugin descriptor failure");
        },
      },
    );
    for (const instructions of [{ "zh-Hans": "missing default" }, accessor, throwing]) {
      const { deps, printed } = createDeps({ copyToClipboard: () => false, openBrowser: () => false });
      await expect(
        createCliAuthorizationPort({ ...deps, locale: "zh-Hans" }).presentDeviceCode({
          url: "https://identity.example/device",
          userCode: "SAFE-CODE",
          instructions: instructions as never,
        }),
      ).resolves.toBeUndefined();
      expect(printed).toEqual(["Device code: SAFE-CODE", "https://identity.example/device"]);
    }
    expect(reads).toBe(0);
  });

  test("prints the user code when clipboard copy fails without failing authorization", async () => {
    const { deps, printed } = createDeps({ copyToClipboard: () => false, openBrowser: () => false });
    await createCliAuthorizationPort(deps).presentDeviceCode({
      url: "http://identity.example/device",
      userCode: "SAFE-CODE",
    });
    expect(printed).toEqual(["Device code: SAFE-CODE", "http://identity.example/device"]);
  });

  test("treats clipboard and browser exceptions as presentation failures and still prints the URL", async () => {
    const { deps, printed } = createDeps({
      copyToClipboard: () => {
        throw new Error("clipboard details");
      },
      openBrowser: () => {
        throw new Error("browser details");
      },
    });
    await createCliAuthorizationPort(deps).presentDeviceCode({
      url: "https://identity.example/device",
      userCode: "SAFE-CODE",
    });
    expect(printed).toEqual(["Device code: SAFE-CODE", "https://identity.example/device"]);
  });

  test("rejects a non-HTTP verification URL before opening a browser", async () => {
    const { deps, opened, printed } = createDeps();
    await expect(
      createCliAuthorizationPort(deps).presentDeviceCode({ url: "javascript:alert(1)", userCode: "SECRET" }),
    ).rejects.toBeInstanceOf(AuthorizationUrlInvalidError);
    expect(opened).toEqual([]);
    expect(printed).toEqual([]);
  });
});
