import type { ZodType } from "@aio-proxy/plugin-sdk";

export async function fetchJson<Output>(url: string, init: RequestInit, schema: ZodType<Output>): Promise<Output> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`GitHub Copilot request failed (${response.status})`);
  return await schema.parseAsync(await response.json());
}

export function copilotHeaders(token: string): HeadersInit {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  };
}

export function authHeaders(token: string): HeadersInit {
  return { accept: "application/json", authorization: `Bearer ${token}` };
}
