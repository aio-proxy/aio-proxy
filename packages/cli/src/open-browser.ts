import { spawn } from "node:child_process";

export type BrowserCommand = {
  readonly bin: string;
  readonly args: readonly string[];
};

type BrowserSpawn = (
  bin: string,
  args: readonly string[],
  options: {
    readonly detached: true;
    readonly stdio: "ignore";
    readonly windowsVerbatimArguments?: true;
  },
) => { unref(): void };

export type OpenBrowserDeps = {
  readonly platform: NodeJS.Platform;
  readonly spawn: BrowserSpawn;
};

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  if (platform === "darwin") return { bin: "open", args: [url] };
  if (platform === "win32") {
    const quotedUrl = `"${url.replaceAll('"', "%22")}"`;
    return { bin: "cmd", args: ["/d", "/s", "/c", "start", '""', quotedUrl] };
  }
  return { bin: "xdg-open", args: [url] };
}

export function createOpenBrowser(deps: OpenBrowserDeps): (url: string) => boolean {
  return (url) => {
    const command = browserCommand(url, deps.platform);
    try {
      const child = deps.spawn(command.bin, command.args, {
        detached: true,
        stdio: "ignore",
        ...(deps.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  };
}

export const openBrowser = createOpenBrowser({
  platform: process.platform,
  spawn: (bin, args, options) => spawn(bin, [...args], options),
});
