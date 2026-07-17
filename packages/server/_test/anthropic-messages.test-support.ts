import { openDb, requestLog, usage } from "@aio-proxy/core/db";
import type { TextStreamPart, ToolSet } from "ai";

export { createTempHomes } from "./temporary-homes.test-support";

export const messagesRequest = {
  model: "claude-sonnet-4-5",
  max_tokens: 32,
  messages: [{ role: "user", content: "Hello proxy" }],
  stream: true,
};
export async function recorded(home: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const handle = openDb({ home });
    const requests = handle.db.select().from(requestLog).all();
    const usages = handle.db.select().from(usage).all();
    handle.close();
    if (requests.length > 0) return { requests, usages };
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("request row was not recorded");
}

export function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

export class AbortStreamError extends Error {
  override readonly name = "AbortError";
}
