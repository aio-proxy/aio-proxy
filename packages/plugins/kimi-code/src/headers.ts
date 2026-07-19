import * as systemOs from "node:os";
import packageJson from "../package.json" with { type: "json" };

type OsPort = Pick<typeof systemOs, "hostname" | "platform" | "release" | "arch" | "version">;

const printable = (value: string, fallback = "unknown") => value.replace(/[^\x20-\x7e]/gu, "").trim() || fallback;

export function kimiIdentityHeaders(deviceId: string, os: OsPort = systemOs): Readonly<Record<string, string>> {
  const platform = os.platform();
  const name =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  return Object.freeze({
    "User-Agent": `KimiCLI/${packageJson.version}`,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": packageJson.version,
    "X-Msh-Device-Name": printable(os.hostname()),
    "X-Msh-Device-Model": printable(`${name} ${os.release()} ${os.arch()}`),
    "X-Msh-Os-Version": printable(os.version()),
    "X-Msh-Device-Id": printable(deviceId),
  });
}
