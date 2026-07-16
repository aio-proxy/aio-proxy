import { spawn } from "node:child_process";

export type BrowserCommand = {
  readonly bin: string;
  readonly args: readonly string[];
};

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  if (platform === "darwin") return { bin: "open", args: [url] };
  if (platform === "win32") {
    const quotedUrl = `"${url.replaceAll('"', "%22")}"`;
    return { bin: "cmd", args: ["/d", "/s", "/c", "start", '""', quotedUrl] };
  }
  return { bin: "xdg-open", args: [url] };
}

export function openBrowser(url: string): boolean {
  const command = browserCommand(url);
  try {
    const child = spawn(command.bin, command.args, {
      detached: true,
      stdio: "ignore",
      ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
