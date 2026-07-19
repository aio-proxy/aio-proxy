import { kimiClientId } from "../rslib.config";

const fingerprint = new Bun.CryptoHasher("sha256").update(kimiClientId).digest("hex");
if (fingerprint !== "9a51d8fba526c54bf355205a99c8325ec07a056024515f826987cb2a042a13ac") {
  throw new Error("Kimi OAuth credential fingerprint mismatch");
}

Object.assign(globalThis, {
  __AIO_PROXY_KIMI_CLIENT_ID__: kimiClientId,
});
