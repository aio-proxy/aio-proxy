import { homedir } from "node:os";
import { join } from "node:path";

export const defaultConfigPath = () => {
  const appData = (process.env as { readonly APPDATA?: string }).APPDATA;
  if (process.platform === "win32" && appData !== undefined) {
    return join(appData, "aio-proxy", "config.jsonc");
  }
  return join(homedir(), ".config", "aio-proxy", "config.jsonc");
};

export const resolveConfigPath = (optionPath: string | undefined) =>
  optionPath ?? (process.env as { readonly AIO_PROXY_CONFIG?: string }).AIO_PROXY_CONFIG ?? defaultConfigPath();
