import { defineLibraryConfig } from "@aio-proxy/infra/rslib";

const decode = (...parts: string[]) => atob(parts.join(""));

export const googleAntigravityClientId = decode(
  "MTA3MTAwNjA2MDU5MS",
  "10bWhzc2luMmgyMWxjcmUy",
  "MzV2dG9sb2poNGc0MDNlcC5hcHBz",
  "Lmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
export const googleAntigravityClientSecret = decode("R09DU1BYLUs1OEZXUjQ4", "NkxkTEoxbUxCOHNYQzR6NnFEQWY=");

export default defineLibraryConfig({
  source: {
    define: {
      __AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__: JSON.stringify(googleAntigravityClientId),
      __AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__: JSON.stringify(googleAntigravityClientSecret),
    },
  },
});
