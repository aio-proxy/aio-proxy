import { googleAntigravityClientId, googleAntigravityClientSecret } from "../rslib.config";

const expectedFingerprints = [
  "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea",
  "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60",
];
const values = [googleAntigravityClientId, googleAntigravityClientSecret];

for (const [index, value] of values.entries()) {
  const fingerprint = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  if (fingerprint !== expectedFingerprints[index]) throw new Error("Google OAuth credential fingerprint mismatch");
}

Object.assign(globalThis, {
  __AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__: googleAntigravityClientId,
  __AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__: googleAntigravityClientSecret,
});
