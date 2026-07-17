import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";
import type { CliAuthorizationDeps } from "../authorization";

export const copy = {
  copiedDeviceCode: "Copied device code.",
  deviceCode: (code: string) => `Device code: ${code}`,
  openedAuthorizationPage: "Opened authorization page.",
  successHtml: "<html><body>Authorization complete.</body></html>",
  alreadyCompleted: "Authorization already completed (test copy).",
  invalidCallback: "Invalid OAuth callback (test copy).",
  notFound: "Not found (test copy).",
} as const;

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

export function resetInteractive(): void {
  if (originalIsTTY === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
  else Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
}

export function setInteractive(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

function pendingManual(_authorizationUrl: string, signal: AbortSignal): Promise<string> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(signal.reason);
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

export function createDeps(overrides: Partial<CliAuthorizationDeps> = {}): {
  readonly controller: AbortController;
  readonly deps: CliAuthorizationDeps;
  readonly opened: string[];
  readonly printed: string[];
} {
  const controller = new AbortController();
  const opened: string[] = [];
  const printed: string[] = [];
  return {
    controller,
    opened,
    printed,
    deps: {
      copy,
      openBrowser: (url) => {
        opened.push(url);
        return true;
      },
      copyToClipboard: () => true,
      print: (message) => printed.push(message),
      readManualCallbackUrl: pendingManual,
      confirmManualOnly: async () => false,
      signal: controller.signal,
      ...overrides,
    },
  };
}

export function request(overrides: Partial<LoopbackRequest> = {}): LoopbackRequest {
  return {
    state: "expected-state",
    redirect: { hostname: "localhost", port: "dynamic", path: "/auth/callback" },
    authorizationUrl: ({ redirectUri }) =>
      `https://identity.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
    allowManualCallbackUrl: false,
    ...overrides,
  };
}

export async function expectPortAvailable(port: number): Promise<void> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response(null, { status: 204 }),
  });
  await probe.stop(true);
}
