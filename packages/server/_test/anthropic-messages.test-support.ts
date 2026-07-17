import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AiSdkProviderError,
  type AiSdkProviderInstance,
  type ApiProviderInstance,
  createAiSdkProvider,
} from "@aio-proxy/core";
import { openDb, requestLog, usage } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

export const messagesRequest = {
  model: "claude-sonnet-4-5",
  max_tokens: 32,
  messages: [{ role: "user", content: "Hello proxy" }],
  stream: true,
};
export function createTempHomes(prefix: string) {
  const homes: string[] = [];
  return {
    cleanup: () => {
      for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
    },
    tempHome: () => {
      const home = mkdtempSync(join(tmpdir(), prefix));
      homes.push(home);
      return home;
    },
  };
}

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
