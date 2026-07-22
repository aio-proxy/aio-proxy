import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Self-contained public types for the Node-only openai-stream subpath export. */
export const OPENAI_STREAM_DTS = `export type OpenAIStreamProtocol = "openai-response" | "openai-compatible";

export declare function createOpenAIStreamFetch(
  protocol: OpenAIStreamProtocol,
  fetcher?: typeof globalThis.fetch,
): typeof globalThis.fetch;
`;

export function createOpenAIStreamDtsPlugin(): RsbuildPlugin {
  return {
    name: "aio-proxy-openai-stream-dts",
    apply: "build",
    setup(api) {
      api.onAfterBuild(() => {
        const outDir = join(api.context.rootPath, "dist", "openai-stream");
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "index.d.ts"), OPENAI_STREAM_DTS);
      });
    },
  };
}
