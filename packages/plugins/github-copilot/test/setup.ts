import { githubCopilotClientId } from "../rslib.config";

const fingerprint = new Bun.CryptoHasher("sha256").update(githubCopilotClientId).digest("hex");
if (fingerprint !== "9954bfea80f3d9092fcfed1cf263006469bc818ce55ee7114580fe2a8142af71") {
  throw new Error("GitHub Copilot OAuth credential fingerprint mismatch");
}

Object.assign(globalThis, {
  __AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__: githubCopilotClientId,
});
