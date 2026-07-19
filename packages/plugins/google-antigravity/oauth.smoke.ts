import { expect, test } from "bun:test";

import { googleAntigravityClientId, googleAntigravityClientSecret } from "./rslib.config";

test("build embeds Google OAuth credentials without leaving source plaintext", async () => {
  const [source, config, setup, artifact, publicApi] = await Promise.all([
    Bun.file("./src/oauth/constants.ts").text(),
    Bun.file("./rslib.config.ts").text(),
    Bun.file("./test/setup.ts").text(),
    Bun.file("./dist/oauth/constants.js").text(),
    import("./dist/index.js"),
  ]);

  const credentials = [
    [googleAntigravityClientId, "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea"],
    [googleAntigravityClientSecret, "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60"],
  ] as const;
  for (const [value, expectedFingerprint] of credentials) {
    expect(new Bun.CryptoHasher("sha256").update(value).digest("hex")).toBe(expectedFingerprint);
    for (const text of [source, config, setup]) {
      expect(text.includes(value)).toBe(false);
      expect(text.includes(btoa(value))).toBe(false);
    }
    expect(artifact.includes(value)).toBe(true);
  }
  expect(artifact.includes("__AIO_PROXY_GOOGLE_ANTIGRAVITY_")).toBe(false);
  expect(/\batob\s*\(/u.test(artifact)).toBe(false);
  expect(Object.hasOwn(publicApi, "GOOGLE_CLIENT_SECRET")).toBe(false);
  expect(publicApi.GOOGLE_CLIENT_ID).toBe(googleAntigravityClientId);
});
