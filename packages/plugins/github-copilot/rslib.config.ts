import { defineLibraryConfig } from "@aio-proxy/infra/rslib";

const decode = (...parts: string[]) => atob(parts.join(""));

export const githubCopilotClientId = decode("SXYxLmI1MDdhMDhjODdlY2Zl", "OTg=");

export default defineLibraryConfig({
  source: {
    define: {
      __AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__: JSON.stringify(githubCopilotClientId),
    },
  },
});
