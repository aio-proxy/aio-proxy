import type { XAIGrokFetch } from "../oauth";

export class XAIOAuthHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function postForm(
  fetcher: XAIGrokFetch,
  url: string,
  body: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await postFormResponse(fetcher, url, body, signal);
  if (!response.ok) {
    throw new XAIOAuthHttpError("xAI OAuth request failed", isRetryableStatus(response.status), response.status);
  }
  return await response.json();
}

export async function postFormResponse(
  fetcher: XAIGrokFetch,
  url: string,
  body: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  return await request(fetcher, url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal,
  });
}

export async function request(fetcher: XAIGrokFetch, input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch {
    if (init.signal?.aborted) throw init.signal.reason;
    throw new XAIOAuthHttpError("xAI OAuth network request failed", true);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
