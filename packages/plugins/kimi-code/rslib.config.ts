import { defineLibraryConfig } from "@aio-proxy/infra/rslib";

const decode = (...parts: string[]) => atob(parts.join(""));
export const kimiClientId = decode("MTdlNWY2NzEtZDE5NC00ZGZi", "LTk3MDYtNTUxNmNiNDhjMDk4");

export default defineLibraryConfig({
  source: { define: { __AIO_PROXY_KIMI_CLIENT_ID__: JSON.stringify(kimiClientId) } },
});
