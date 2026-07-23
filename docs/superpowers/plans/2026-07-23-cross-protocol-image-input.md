# Cross-Protocol Image Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve ordinary and tool-result images as real visual inputs across OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and Gemini generateContent routing, without changing same-protocol raw passthrough.

**Architecture:** Every inbound adapter converts supported image syntax into tagged AI SDK `FilePart` values. OpenAI Responses, Anthropic, and Gemini use their pinned AI SDK encoders; OpenAI-compatible model requests use one marked, model-path-only CPA wire rewrite. The server resolves a candidate's target protocol and runs a narrow image preflight before invocation so an unsafe representation skips that candidate through the existing fallback loop.

**Tech Stack:** Bun workspace, TypeScript, Zod, AI SDK 7 (`ai@7.0.8`), `@ai-sdk/openai@4.0.4`, `@ai-sdk/anthropic@4.0.3`, `@ai-sdk/google@4.0.3`, `@ai-sdk/openai-compatible@3.0.2`, Bun test, Rslib.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-23-cross-protocol-image-input-design.md`; do not broaden or reinterpret its scope.
- Work from commit `f18445e` or a descendant. Before Task 1, run `rtk git status --short`; preserve unrelated user changes and stop if they overlap a listed file.
- Use `Provider ID` and `Provider weight` exactly as the repository domain language requires.
- Same-protocol raw capability always wins and must receive the original protocol body except for the existing model/path rewrite.
- Cross-protocol calls must use AI SDK `ModelMessage` file parts; do not add pairwise protocol translators.
- Cover images only. Do not add document, audio, video, media downloading, a vision-capability database, or same-candidate semantic retries.
- Remote URLs remain URLs and must be HTTP(S); aio-proxy must never download them.
- Never silently remove an image, stringify image bytes as tool text, or report success after sending a nonvisual substitute.
- Diagnostics and typed errors may contain only a reason category and structural path; never include base64, a complete URL, or a Provider file ID.
- The CPA `role: "tool"` image array is emitted only for AI SDK model traffic targeting `openai-compatible`; raw passthrough must not be rewritten.
- A rejected CPA extension is an ordinary candidate failure. Continue to the next Provider; do not retry the same Provider after moving an image into a user message.
- Use existing dependencies only. Do not add a utility or media dependency.
- Keep every handwritten source or test file below 300 lines. At 240 lines, split by responsibility before adding more.
- Move materially changed legacy `_test` files next to their source as listed below. `@aio-proxy/core` already runs `bun test`, so no package script change is required.
- Use `rtk` before every shell command and `apply_patch` for every file edit or move.
- Each task is a separate review gate and commit. Every commit in this plan includes `Co-authored-by: Codex <noreply@openai.com>`.
- The final verification is `rtk bun run preflight`; do not claim completion until it passes.

---

## Locked File Structure

Create one image-specific core unit, not a generic media framework:

```text
packages/core/src/image-input/
├── index.ts                       # public exports only
├── image-input.ts                 # constructors, marker, package target map, preflight
└── image-input.test.ts            # constructor and preflight contracts
```

Materially changed legacy modules must end in these layouts:

```text
packages/core/src/transform/openai-responses/
├── index.ts
├── openai-responses.ts
├── compat.ts
├── input-content.ts
├── from-model.ts
├── tools.ts
├── types.ts
├── openai-responses.test.ts
├── compatibility.test.ts
├── roundtrip.test.ts
└── images.test.ts

packages/core/src/transform/openai-completions/
├── index.ts
├── openai-completions.ts
├── openai-completions-from-model.ts
└── openai-completions.test.ts

packages/core/src/ingress/anthropic-messages/
├── index.ts
├── anthropic-messages.ts
└── anthropic-messages.test.ts

packages/core/src/transform/anthropic-messages/
├── index.ts
├── anthropic-messages.ts
├── to-model.ts
├── types.ts
├── anthropic-messages.test.ts
└── anthropic-messages-images.test.ts

packages/core/src/protocol/anthropic-messages/
├── index.ts
├── anthropic-messages.ts
├── anthropic-messages.test.ts
└── anthropic-messages-images.test.ts

packages/core/src/ingress/gemini-generate-content/
├── index.ts
├── gemini-generate-content.ts
└── gemini-generate-content.test.ts

packages/core/src/transform/gemini-generate-content/
├── index.ts
├── gemini-generate-content.ts
├── gemini-generate-content-from-model.ts
├── gemini-generate-content-types.ts
└── gemini-generate-content.test.ts

packages/plugins/github-copilot/src/runtime/
├── index.ts
├── runtime.ts
├── runtime.test.ts
└── tool-images.test.ts

packages/plugins/kimi-code/src/runtime/
├── index.ts
├── runtime.ts
├── runtime.test.ts
└── tool-images.test.ts
```

Keep fixtures under the existing `packages/core/_test/fixtures/` directories. From a new `src/<layer>/<module>/` test, use `../../../_test/fixtures/<module>`.

## Locked Cross-Task Interfaces

Task 2 owns these names. Later tasks must consume them exactly:

```ts
export type ImageInputDetail = "auto" | "low" | "high";

export type ImageFileSource =
  | { readonly type: "base64"; readonly mediaType: string; readonly data: string }
  | { readonly type: "url"; readonly url: string; readonly mediaType?: string }
  | { readonly type: "reference"; readonly provider: string; readonly id: string; readonly mediaType?: string };

export type ImageFilePartOptions = {
  readonly detail?: ImageInputDetail;
  readonly toolResult?: boolean;
};

export function imageFilePart(
  source: ImageFileSource,
  options?: ImageFilePartOptions,
): FilePart | undefined;

export function isValidBase64(value: string): boolean;
export function isImageMediaType(value: string): boolean;
export function isHttpUrl(value: string): boolean;
export function imageTargetProtocolForPackage(packageName: string): ProviderProtocol | undefined;
export function assertImageInputSupported(
  messages: readonly ModelMessage[],
  targetProtocol: ProviderProtocol | undefined,
): void;
```

The internal marker is also fixed:

```ts
providerOptions: {
  aioProxy: { toolImage: true },
}
```

Task 9 extends transport metadata with this exact optional resolver:

```ts
readonly targetProtocol?: (modelId: string) => ProviderProtocol | undefined;
```

### Task 1: Repair the ChatGPT Runtime Artifact Boundary

**Files:**

- Modify: `packages/plugins/openai-chatgpt/src/plugin.ts:15`
- Modify: `packages/plugins/openai-chatgpt/oauth.smoke.ts`

**Interfaces:**

- Consumes: the existing `PluginDescriptor.setup()` and registered `OAuthAdapter.createRuntime()` contracts.
- Produces: a clean-build artifact whose `dist/plugin.js` imports `./runtime/index.js` and whose runtime exposes raw OpenAI Responses capability.

- [x] **Step 1: Add the artifact assertions**

In `oauth.smoke.ts`, add the two type imports below the existing imports, then add this test and helper below the current client-ID test. Do not modify the current client-ID test. The code is complete and must be copied exactly:

```ts
import type { OAuthAdapter, PluginDescriptor } from "@aio-proxy/plugin-sdk";

import type { ChatGPTCredential } from "./src/schema";

test("clean build resolves the current runtime entry and exposes Responses raw capability", async () => {
  const [{ default: descriptor }, pluginArtifact] = await Promise.all([
    import("./dist/index.js"),
    Bun.file("./dist/plugin.js").text(),
  ]);
  const adapter = await registeredAdapter(descriptor);
  const runtime = await adapter.createRuntime({
    credentials: {
      read: async () => ({
        revision: 1,
        value: {
          accessToken: "artifact-access",
          accountId: "artifact-account",
          expiresAt: Date.now() + 60_000,
          refreshToken: "artifact-refresh",
        },
      }),
      refresh: async () => {
        throw new Error("artifact test must not refresh credentials");
      },
    },
    options: {},
    catalog: {
      language: [{ id: "gpt-artifact" }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    },
  });

  expect(pluginArtifact).toContain('from "./runtime/index.js"');
  expect(runtime.raw?.({ protocol: "openai-response", modelId: "gpt-artifact" })).toBeDefined();
  expect(runtime.raw?.({ protocol: "openai-compatible", modelId: "gpt-artifact" })).toBeUndefined();
});

async function registeredAdapter(
  descriptor: PluginDescriptor,
): Promise<OAuthAdapter<Record<string, never>, ChatGPTCredential>> {
  let adapter: OAuthAdapter<Record<string, never>, ChatGPTCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(value) {
          adapter = value as OAuthAdapter<Record<string, never>, ChatGPTCredential>;
        },
      },
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {},
        child() {
          return this;
        },
      },
    },
    undefined,
  );
  if (adapter === undefined) throw new Error("built plugin did not register its OAuth adapter");
  return adapter;
}
```

Do not replace `ChatGPTCredential` with `never` or remove `logger.child()`: both make the helper fail strict type checking.

- [x] **Step 2: Run the artifact test and record the current artifact state**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt build
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:artifact
```

Expected: record whether the artifact assertion currently passes or fails. This is not a red-test gate: `build` is clean and may already remove the stale `dist/runtime.js` that appears only after `rslib --watch --no-clean`. Continue to Step 3 either way. The post-fix clean-build assertion in Step 4 is the regression gate.

- [x] **Step 3: Make the source import unambiguous**

Replace the import in `src/plugin.ts`:

```ts
import { createOpenAIChatGPTRuntime } from "./runtime/index";
```

Do not delete `dist/` manually. The package's ordinary `build` is clean; its `dev` script intentionally remains `--no-clean`.

- [x] **Step 4: Rebuild and verify the artifact**

Run:

```bash
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt build
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:artifact
```

Expected: both commands exit 0; the artifact assertion sees `./runtime/index.js`, Responses raw resolution is defined, and incompatible raw resolution is undefined.

- [x] **Step 5: Commit Task 1**

```bash
rtk git add packages/plugins/openai-chatgpt/src/plugin.ts packages/plugins/openai-chatgpt/oauth.smoke.ts
rtk git commit -m "fix(openai-chatgpt): resolve runtime entry explicitly" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Add the Canonical Image Constructors and Compatibility Preflight

**Files:**

- Create: `packages/core/src/image-input/index.ts`
- Create: `packages/core/src/image-input/image-input.ts`
- Create: `packages/core/src/image-input/image-input.test.ts`
- Modify: `packages/core/src/error.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: AI SDK `FilePart` and `ModelMessage`, plus `ProviderProtocol`.
- Produces: every interface in “Locked Cross-Task Interfaces”, `ImageInputUnsupportedError`, and a marker that Task 8 can recognize without guessing arbitrary JSON.

- [x] **Step 1: Write the failing constructor and preflight tests**

Create `image-input.test.ts` with these behavior checks:

```ts
import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import type { ModelMessage } from "../ai-sdk-bridge";

import { ImageInputUnsupportedError } from "../error";
import {
  assertImageInputSupported,
  imageFilePart,
  imageTargetProtocolForPackage,
  isHttpUrl,
  isImageMediaType,
  isValidBase64,
} from ".";

describe("imageFilePart", () => {
  test("normalizes data URLs, remote URLs, details, references, and tool markers", () => {
    expect(
      imageFilePart(
        { type: "url", url: "data:image/png;base64,AA==" },
        { detail: "low", toolResult: true },
      ),
    ).toEqual({
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: "AA==" },
      providerOptions: {
        openai: { imageDetail: "low" },
        aioProxy: { toolImage: true },
      },
    });
    expect(imageFilePart({ type: "url", url: "https://example.test/image.png" })).toEqual({
      type: "file",
      mediaType: "image",
      data: { type: "url", url: new URL("https://example.test/image.png") },
    });
    expect(imageFilePart({ type: "reference", provider: "openai", id: "file_123" })).toEqual({
      type: "file",
      mediaType: "image",
      data: { type: "reference", reference: { openai: "file_123" } },
    });
  });

  test("rejects malformed bytes, MIME types, data URLs, and non-HTTP URLs", () => {
    expect(isValidBase64("AA==")).toBe(true);
    expect(isValidBase64("not base64")).toBe(false);
    expect(isImageMediaType("image/webp")).toBe(true);
    expect(isImageMediaType("application/pdf")).toBe(false);
    expect(isHttpUrl("https://example.test/image.png")).toBe(true);
    expect(isHttpUrl("http:///")).toBe(false);
    expect(isHttpUrl("file:///tmp/image.png")).toBe(false);
    expect(imageFilePart({ type: "base64", mediaType: "image/png", data: "!" })).toBeUndefined();
    expect(imageFilePart({ type: "base64", mediaType: "image", data: "AA==" })).toBeUndefined();
    expect(imageFilePart({ type: "url", url: "data:image/png;base64,!" })).toBeUndefined();
    expect(imageFilePart({ type: "url", url: "ftp://example.test/image.png" })).toBeUndefined();
  });
});

describe("image compatibility preflight", () => {
  const remoteToolImage = [
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "call_1",
          toolName: "inspect",
          output: {
            type: "content" as const,
            value: [
              {
                type: "file" as const,
                mediaType: "image",
                data: { type: "url" as const, url: new URL("https://example.test/image.png") },
                providerOptions: { aioProxy: { toolImage: true } },
              },
            ],
          },
        },
      ],
    },
  ] satisfies readonly ModelMessage[];

  test("rejects remote Gemini tool images and unresolved tool targets", () => {
    expect(() => assertImageInputSupported(remoteToolImage, ProviderProtocol.Gemini)).toThrow(
      new ImageInputUnsupportedError("gemini-tool-url", "messages.0.content.0.output.value.0"),
    );
    expect(() => assertImageInputSupported(remoteToolImage, undefined)).toThrow(
      new ImageInputUnsupportedError("unknown-target", "messages.0.content.0.output.value.0"),
    );
    expect(() => assertImageInputSupported(remoteToolImage, ProviderProtocol.Anthropic)).not.toThrow();
  });

  test("allows an OpenAI user reference only on the OpenAI Responses target", () => {
    const reference = [
      {
        role: "user" as const,
        content: [
          {
            type: "file" as const,
            mediaType: "image",
            data: { type: "reference" as const, reference: { openai: "file_123" } },
          },
        ],
      },
    ] satisfies readonly ModelMessage[];

    expect(() => assertImageInputSupported(reference, ProviderProtocol.OpenAIResponse)).not.toThrow();
    expect(() => assertImageInputSupported(reference, ProviderProtocol.Anthropic)).toThrow(
      new ImageInputUnsupportedError("provider-reference", "messages.0.content.0"),
    );
  });

  test("maps only the four known AI SDK packages", () => {
    expect(imageTargetProtocolForPackage("@ai-sdk/openai")).toBe(ProviderProtocol.OpenAIResponse);
    expect(imageTargetProtocolForPackage("@ai-sdk/openai-compatible")).toBe(ProviderProtocol.OpenAICompatible);
    expect(imageTargetProtocolForPackage("@ai-sdk/anthropic")).toBe(ProviderProtocol.Anthropic);
    expect(imageTargetProtocolForPackage("@ai-sdk/google")).toBe(ProviderProtocol.Gemini);
    expect(imageTargetProtocolForPackage("@vendor/unknown")).toBeUndefined();
  });
});
```

- [x] **Step 2: Run the test and verify the missing module failure**

Run:

```bash
rtk bun test packages/core/src/image-input/image-input.test.ts
```

Expected: FAIL because `packages/core/src/image-input/index.ts` and `ImageInputUnsupportedError` do not exist.

- [x] **Step 3: Add the typed, non-sensitive compatibility error**

Add to `packages/core/src/error.ts` immediately before the protocol transform errors:

```ts
export type ImageInputUnsupportedReason = "gemini-tool-url" | "provider-reference" | "unknown-target";

export class ImageInputUnsupportedError extends AioProxyError {
  readonly code = "UNSUPPORTED_IMAGE_INPUT";

  constructor(
    readonly reason: ImageInputUnsupportedReason,
    readonly path: string,
  ) {
    super("ImageInputUnsupportedError", `Image input cannot be represented: ${reason} at ${path}`);
  }
}
```

The error must never accept the original source string or Provider file ID.

- [x] **Step 4: Implement the canonical constructors and marker**

Create `image-input.ts` with the following implementation. Keep the regexes private and do not add alternative encodings:

```ts
import { ProviderProtocol } from "@aio-proxy/types";

import type { FilePart, ModelMessage } from "../ai-sdk-bridge";

import { ImageInputUnsupportedError } from "../error";

export type ImageInputDetail = "auto" | "low" | "high";

export type ImageFileSource =
  | { readonly type: "base64"; readonly mediaType: string; readonly data: string }
  | { readonly type: "url"; readonly url: string; readonly mediaType?: string }
  | { readonly type: "reference"; readonly provider: string; readonly id: string; readonly mediaType?: string };

export type ImageFilePartOptions = {
  readonly detail?: ImageInputDetail;
  readonly toolResult?: boolean;
};

const fullImageMediaType = /^image\/[A-Za-z0-9!#$&^_.+-]+$/u;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const dataImageUrl = /^data:(image\/[A-Za-z0-9!#$&^_.+-]+);base64,([^,]+)$/u;

export function isValidBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && base64.test(value);
}

export function isImageMediaType(value: string): boolean {
  return value === "image" || fullImageMediaType.test(value);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname !== "" && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

export function imageFilePart(
  source: ImageFileSource,
  options: ImageFilePartOptions = {},
): FilePart | undefined {
  const normalized = normalizeSource(source);
  if (normalized === undefined) return undefined;
  const providerOptions = {
    ...(options.detail === undefined ? {} : { openai: { imageDetail: options.detail } }),
    ...(options.toolResult === true ? { aioProxy: { toolImage: true as const } } : {}),
  };
  return {
    type: "file",
    mediaType: normalized.mediaType,
    data: normalized.data,
    ...(Object.keys(providerOptions).length === 0 ? {} : { providerOptions }),
  };
}

function normalizeSource(source: ImageFileSource): Pick<FilePart, "data" | "mediaType"> | undefined {
  if (source.type === "base64") {
    if (!fullImageMediaType.test(source.mediaType) || !isValidBase64(source.data)) return undefined;
    return { mediaType: source.mediaType, data: { type: "data", data: source.data } };
  }
  if (source.type === "reference") {
    const mediaType = source.mediaType ?? "image";
    if (source.provider === "" || source.id === "" || !isImageMediaType(mediaType)) return undefined;
    return {
      mediaType,
      data: { type: "reference", reference: { [source.provider]: source.id } },
    };
  }
  const match = dataImageUrl.exec(source.url);
  if (match !== null) {
    const mediaType = match[1];
    const data = match[2];
    if (mediaType === undefined || data === undefined || !isValidBase64(data)) return undefined;
    return { mediaType, data: { type: "data", data } };
  }
  const mediaType = source.mediaType ?? "image";
  if (!isHttpUrl(source.url) || !isImageMediaType(mediaType)) return undefined;
  return { mediaType, data: { type: "url", url: new URL(source.url) } };
}

export function imageTargetProtocolForPackage(packageName: string): ProviderProtocol | undefined {
  switch (packageName) {
    case "@ai-sdk/openai":
      return ProviderProtocol.OpenAIResponse;
    case "@ai-sdk/openai-compatible":
      return ProviderProtocol.OpenAICompatible;
    case "@ai-sdk/anthropic":
      return ProviderProtocol.Anthropic;
    case "@ai-sdk/google":
      return ProviderProtocol.Gemini;
    default:
      return undefined;
  }
}

export function assertImageInputSupported(
  messages: readonly ModelMessage[],
  targetProtocol: ProviderProtocol | undefined,
): void {
  for (const [messageIndex, message] of messages.entries()) {
    if (typeof message.content === "string") continue;
    for (const [partIndex, part] of message.content.entries()) {
      const path = `messages.${messageIndex}.content.${partIndex}`;
      if (part.type === "file" && isImageMediaType(part.mediaType)) {
        assertFileSupported(part, targetProtocol, path, false);
      }
      if (part.type === "tool-result" && part.output.type === "content") {
        for (const [outputIndex, outputPart] of part.output.value.entries()) {
          if (outputPart.type === "file" && isImageMediaType(outputPart.mediaType)) {
            assertFileSupported(outputPart, targetProtocol, `${path}.output.value.${outputIndex}`, true);
          }
        }
      }
    }
  }
}

function assertFileSupported(
  part: FilePart,
  targetProtocol: ProviderProtocol | undefined,
  path: string,
  toolResult: boolean,
): void {
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) return;
  if (data.type === "reference") {
    const openAIReference =
      targetProtocol === ProviderProtocol.OpenAIResponse &&
      typeof data.reference["openai"] === "string" &&
      data.reference["openai"].length > 0;
    if (!openAIReference || toolResult) throw new ImageInputUnsupportedError("provider-reference", path);
    return;
  }
  if (!toolResult) return;
  if (targetProtocol === undefined) throw new ImageInputUnsupportedError("unknown-target", path);
  if (targetProtocol === ProviderProtocol.Gemini && data.type === "url") {
    throw new ImageInputUnsupportedError("gemini-tool-url", path);
  }
}
```

- [x] **Step 5: Add the barrel and root exports**

Create `packages/core/src/image-input/index.ts`:

```ts
export {
  assertImageInputSupported,
  imageFilePart,
  imageTargetProtocolForPackage,
  type ImageFilePartOptions,
  type ImageFileSource,
  type ImageInputDetail,
  isHttpUrl,
  isImageMediaType,
  isValidBase64,
} from "./image-input";
```

Add to `packages/core/src/index.ts`:

```ts
export { ImageInputUnsupportedError, type ImageInputUnsupportedReason } from "./error";
export {
  assertImageInputSupported,
  imageFilePart,
  imageTargetProtocolForPackage,
  type ImageFilePartOptions,
  type ImageFileSource,
  type ImageInputDetail,
  isHttpUrl,
  isImageMediaType,
  isValidBase64,
} from "./image-input";
```

Merge the error export into the existing `./error` export block instead of creating a duplicate block.

- [x] **Step 6: Run focused tests and type checking**

Run:

```bash
rtk bun test packages/core/src/image-input/image-input.test.ts
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run check
```

Expected: all commands exit 0. The test must prove exact paths and must not log any source value.

- [x] **Step 7: Commit Task 2**

```bash
rtk git add packages/core/src/image-input packages/core/src/error.ts packages/core/src/index.ts
rtk git commit -m "feat(core): add canonical image input primitives" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Preserve OpenAI Responses User and Tool Images

**Files:**

- Modify: `packages/core/src/ingress/openai-responses/input-items.ts:15-28`
- Move: `packages/core/src/transform/openai-responses.ts` → `packages/core/src/transform/openai-responses/openai-responses.ts`
- Move: `packages/core/src/transform/openai-responses-compat.ts` → `packages/core/src/transform/openai-responses/compat.ts`
- Move: `packages/core/src/transform/openai-responses-from-model.ts` → `packages/core/src/transform/openai-responses/from-model.ts`
- Move: `packages/core/src/transform/openai-responses-tools.ts` → `packages/core/src/transform/openai-responses/tools.ts`
- Move: `packages/core/src/transform/openai-responses-types.ts` → `packages/core/src/transform/openai-responses/types.ts`
- Move: `packages/core/src/transform/openai-responses.test.ts` → `packages/core/src/transform/openai-responses/openai-responses.test.ts`
- Move: `packages/core/src/transform/openai-responses-compatibility.test.ts` → `packages/core/src/transform/openai-responses/compatibility.test.ts`
- Move: `packages/core/src/transform/openai-responses-roundtrip.test.ts` → `packages/core/src/transform/openai-responses/roundtrip.test.ts`
- Create: `packages/core/src/transform/openai-responses/index.ts`
- Create: `packages/core/src/transform/openai-responses/input-content.ts`
- Create: `packages/core/src/transform/openai-responses/images.test.ts`
- Modify: `packages/core/src/egress/openai-responses/state.ts`

**Interfaces:**

- Consumes: Task 2 `imageFilePart()` and its exact tool marker.
- Produces: canonical user `FilePart` values, canonical tool `content` output values, OpenAI detail metadata, and tagged `{ openai: fileId }` references.

- [x] **Step 1: Move and split the Responses transform module**

Use `apply_patch` move directives for all eight moves in the Files list. Do not leave compatibility files at the old paths. Apply these exact import rewrites:

```text
openai-responses/openai-responses.ts:
  ../ingress/openai-responses        -> ../../ingress/openai-responses
  ./openai-responses-types           -> ./types
  ./openai-responses-compat          -> ./compat
  ./openai-responses-from-model      -> ./from-model
  ./openai-responses-tools           -> ./tools

openai-responses/compat.ts:
  ../ai-sdk-bridge                   -> ../../ai-sdk-bridge
  ../ingress/openai-responses        -> ../../ingress/openai-responses
  ../error                           -> ../../error
  ./openai-responses-types           -> ./types
  ./openai-responses-tools           -> ./tools

openai-responses/from-model.ts:
  ../ai-sdk-bridge                   -> ../../ai-sdk-bridge
  ../ingress/openai-responses        -> ../../ingress/openai-responses
  ../error                           -> ../../error
  ./openai-responses-types           -> ./types
  ./openai-responses-tools           -> ./tools

openai-responses/tools.ts:
  ../ai-sdk-bridge                   -> ../../ai-sdk-bridge
  ../ingress/openai-responses        -> ../../ingress/openai-responses
  ../error                           -> ../../error
  ./openai-responses-types           -> ./types

openai-responses/types.ts:
  ../ai-sdk-bridge                   -> ../../ai-sdk-bridge
  ../ingress/openai-responses/index  -> ../../ingress/openai-responses/index
```

In all three moved test files, replace `../index` with `../../index`. In `roundtrip.test.ts`, replace the fixture root with:

```ts
const fixtureRoot = `${import.meta.dir}/../../../_test/fixtures/openai-responses`;
```

Create `index.ts` as the only public entry:

```ts
export { modelMessagesToOpenAIResponses } from "./from-model";
export { openAIResponsesToModelMessages } from "./openai-responses";
export { readOpenAIResponsesWireMetadata } from "./tools";
export type {
  OpenAIResponsesFromModelMessages,
  OpenAIResponsesModelMessages,
  OpenAIResponsesProviderOptions,
  OpenAIResponsesReasoningEffort,
  OpenAIResponsesReasoningSummary,
  OpenAIResponsesTransformSettings,
  OpenAIResponsesTransformTool,
  OpenAIResponsesWireMetadata,
} from "./types";
```

Delete the old re-export blocks from the moved `openai-responses.ts`; the barrel now owns them. In `packages/core/src/egress/openai-responses/state.ts`, replace:

```ts
import { readOpenAIResponsesWireMetadata } from "../../transform/openai-responses-tools";
```

with:

```ts
import { readOpenAIResponsesWireMetadata } from "../../transform/openai-responses";
```

- [x] **Step 2: Replace the old image-rejection regression with preservation tests**

Delete the test named `rejects image function output content on the model path` from the moved `openai-responses.test.ts`. Create `images.test.ts` with these imports, followed by all four tests in this step:

```ts
import { expect, test } from "bun:test";

import {
  OpenAIResponsesTransformError,
  openAIResponsesToModelMessages,
  parseOpenAIResponses,
} from "../../index";
```

Add the following first two tests:

```ts
test("preserves message data images and OpenAI file references", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-sol",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Compare both." },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
          { type: "input_image", file_id: "file_123", detail: "high" },
        ],
      },
    ],
  });

  expect(openAIResponsesToModelMessages(request).messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Compare both." },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: "AA==" },
          providerOptions: { openai: { imageDetail: "low" } },
        },
        {
          type: "file",
          mediaType: "image",
          data: { type: "reference", reference: { openai: "file_123" } },
          providerOptions: { openai: { imageDetail: "high" } },
        },
      ],
    },
  ]);
});

test("preserves ordered images in function and custom tool outputs", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-sol",
    input: [
      { type: "function_call", call_id: "call_function", name: "inspect", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_function",
        output: [
          { type: "input_text", text: "before" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
          { type: "input_text", text: "after" },
        ],
      },
      { type: "custom_tool_call", call_id: "call_custom", name: "computer", input: "click" },
      {
        type: "custom_tool_call_output",
        call_id: "call_custom",
        output: [{ type: "input_image", image_url: "https://example.test/screenshot.png" }],
      },
    ],
  });

  const messages = openAIResponsesToModelMessages(request).messages;
  expect(messages[1]).toEqual({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_function",
        toolName: "inspect",
        output: {
          type: "content",
          value: [
            { type: "text", text: "before" },
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "low" },
                aioProxy: { toolImage: true },
              },
            },
            { type: "text", text: "after" },
          ],
        },
      },
    ],
  });
  expect(messages[3]).toMatchObject({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_custom",
        toolName: "computer",
        output: {
          type: "content",
          value: [
            {
              type: "file",
              mediaType: "image",
              data: { type: "url", url: new URL("https://example.test/screenshot.png") },
              providerOptions: { aioProxy: { toolImage: true } },
            },
          ],
        },
      },
    ],
  });
});
```

Add a malformed-source regression:

```ts
test("rejects malformed image sources as an invalid Responses request", () => {
  const request = parseOpenAIResponses({
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "file:///tmp/private.png" }] }],
  });

  expect(() => openAIResponsesToModelMessages(request)).toThrow(
    new OpenAIResponsesTransformError("input.0.content.0.image_url"),
  );
});
```

Add a parser contract regression so the exclusive source rule is protected independently of the transform:

```ts
test("requires exactly one source on every Responses input_image", () => {
  expect(() =>
    parseOpenAIResponses({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: [{ type: "input_image" }] }],
    }),
  ).toThrow();
  expect(() =>
    parseOpenAIResponses({
      model: "gpt-5.6-sol",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA==",
              file_id: "file_123",
            },
          ],
        },
      ],
    }),
  ).toThrow();
});
```

- [x] **Step 3: Run the focused Responses test and observe both missing behaviors**

Run:

```bash
rtk bun test packages/core/src/transform/openai-responses/images.test.ts
```

Expected: FAIL. The `file_id` case is rejected by the current ingress schema before conversion, while the image-output case reaches the existing `OpenAI Responses feature is not supported: input_image` path. Both failures are expected until Steps 3–5 are complete.

- [x] **Step 4: Accept exactly one `image_url` or `file_id`**

Replace `inputImagePartSchema` in `input-items.ts` with:

```ts
const inputImagePartSchema = z
  .object({
    type: z.literal("input_image"),
    image_url: z.string().optional(),
    file_id: idSchema.optional(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  })
  .passthrough()
  .superRefine((part, context) => {
    if ((part.image_url === undefined ? 0 : 1) + (part.file_id === undefined ? 0 : 1) !== 1) {
      context.addIssue({ code: "custom", message: "Expected exactly one image source" });
    }
  });
```

Do not add `input_file` document conversion.

- [x] **Step 5: Extract the input-content mapper and add image construction**

Create `input-content.ts` with these imports and aliases. They are intentionally private to the Responses transform directory:

```ts
import type { FilePart, ModelMessage } from "../../ai-sdk-bridge";
import type {
  OpenAIResponsesInputMessage,
  OpenAIResponsesToolOutputPart,
} from "../../ingress/openai-responses";
import type { OpenAIResponsesWireMetadata } from "./types";

import { OpenAIResponsesTransformError } from "../../error";
import { imageFilePart } from "../../image-input";
import {
  rejectOpenAIResponsesFeature,
  warnOpenAIResponsesDegradation,
  wireProviderOptions,
} from "./tools";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResultPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type UserPart = Exclude<UserMessage["content"], string>[number];
type MessagePart = Extract<UserPart | AssistantPart, { type: "file" | "text" }>;
type InputImagePart = Extract<OpenAIResponsesToolOutputPart, { type: "input_image" }>;

function openAIImagePart(part: InputImagePart, path: string, toolResult: boolean): FilePart {
  const image =
    part.image_url !== undefined
      ? imageFilePart(
          { type: "url", url: part.image_url },
          { ...(part.detail === undefined ? {} : { detail: part.detail }), toolResult },
        )
      : imageFilePart(
          { type: "reference", provider: "openai", id: part.file_id ?? "" },
          { ...(part.detail === undefined ? {} : { detail: part.detail }), toolResult },
        );
  if (image === undefined) {
    throw new OpenAIResponsesTransformError(`${path}.${part.image_url === undefined ? "file_id" : "image_url"}`);
  }
  return image;
}
```

- [x] **Step 6: Move and replace the message and tool-output mappers**

Move `inputMessage()` and `toolOutput()` out of `compat.ts` into `input-content.ts`, export both functions, and delete their old definitions. Add this import to `compat.ts`:

```ts
import { inputMessage, toolOutput } from "./input-content";
```

Remove the now-unused `OpenAIResponsesInputMessage` and `OpenAIResponsesToolOutputPart` imports from `compat.ts`. In `input-content.ts`, add this complete `inputMessage()` implementation after `openAIImagePart()`:

```ts
export function inputMessage(message: OpenAIResponsesInputMessage, index: number): ModelMessage {
  const metadata: OpenAIResponsesWireMetadata | undefined =
    message.type === undefined &&
    message.id === undefined &&
    message.status === undefined &&
    message.phase === undefined &&
    message.role !== "developer"
      ? undefined
      : {
          protocol: "openai-responses",
          inputIndex: index,
          itemType: message.type ?? "message",
          ...(message.id === undefined ? {} : { itemId: message.id }),
          ...(message.status === undefined ? {} : { status: message.status }),
          ...(message.phase === undefined ? {} : { phase: message.phase }),
          wireRole: message.role,
        };
  if (message.role === "developer") {
    warnOpenAIResponsesDegradation("message.role.developer", `input.${index}.role`, "converted");
  }
  const options = metadata === undefined ? {} : { providerOptions: wireProviderOptions(metadata) };
  switch (message.role) {
    case "system":
    case "developer": {
      const content = textMessageContent(message, index);
      return {
        role: "system",
        content: typeof content === "string" ? content : content.map((part) => part.text).join(""),
        ...options,
      };
    }
    case "user":
      return { role: "user", content: messageContent(message, index), ...options };
    case "assistant":
      return { role: "assistant", content: textMessageContent(message, index), ...options };
  }
}
```

Then add these two private content functions. `messageContent()` is only for `role: "user"`; `textMessageContent()` deliberately rejects `input_image` for system, developer, and assistant roles because this feature does not expand assistant-image semantics:

```ts
function messageContent(message: OpenAIResponsesInputMessage, index: number): string | MessagePart[] {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part, partIndex) => {
    const path = `input.${index}.content.${partIndex}`;
    if (part.type === "input_image") return openAIImagePart(part, path, false);
    if (!("text" in part) || typeof part.text !== "string") {
      return rejectOpenAIResponsesFeature(part.type, `${path}.type`);
    }
    if (part.annotations !== undefined || part.logprobs !== undefined) {
      warnOpenAIResponsesDegradation("message.content_metadata", path, "dropped");
    }
    return { type: "text", text: part.text };
  });
}

function textMessageContent(
  message: OpenAIResponsesInputMessage,
  index: number,
): string | { type: "text"; text: string }[] {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part, partIndex) => {
    const path = `input.${index}.content.${partIndex}`;
    if (part.type === "input_image") throw new OpenAIResponsesTransformError(`${path}.type`);
    if (!("text" in part) || typeof part.text !== "string") {
      return rejectOpenAIResponsesFeature(part.type, `${path}.type`);
    }
    if (part.annotations !== undefined || part.logprobs !== undefined) {
      warnOpenAIResponsesDegradation("message.content_metadata", path, "dropped");
    }
    return { type: "text", text: part.text };
  });
}
```

Add this exported `toolOutput()` to the same file:

```ts
export function toolOutput(output: string | OpenAIResponsesToolOutputPart[], path: string): ToolResultPart["output"] {
  if (typeof output === "string") return { type: "text", value: output };
  return {
    type: "content",
    value: output.map((part, index) => {
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        return { type: "text", text: part.text };
      }
      if (part.type === "input_image") return openAIImagePart(part, `${path}.${index}`, true);
      return rejectOpenAIResponsesFeature(part.type, `${path}.${index}.type`);
    }),
  };
}
```

Do not alter the existing `CallIdentity`, function/custom metadata, call grouping, or output-kind metadata.

- [x] **Step 7: Run Responses tests and core checking**

Run:

```bash
rtk bun test packages/core/src/transform/openai-responses packages/core/src/ingress/openai-responses/request.test.ts
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run check
```

Expected: all commands exit 0; the original request shape no longer raises the local 501, and invalid image sources still map to the Responses 400 path through `OpenAIResponsesTransformError`.

- [x] **Step 8: Confirm old Responses transform paths are gone**

Run:

```bash
rtk rg -n 'transform/openai-responses-(compat|from-model|tools|types)|transform/openai-responses\.test|transform/openai-responses-(compatibility|roundtrip)\.test' packages/core
```

Expected: no output.

- [x] **Step 9: Commit Task 3**

```bash
rtk git add -A -- packages/core/src/ingress/openai-responses/input-items.ts packages/core/src/transform/openai-responses packages/core/src/transform/openai-responses.ts packages/core/src/transform/openai-responses-compat.ts packages/core/src/transform/openai-responses-from-model.ts packages/core/src/transform/openai-responses-tools.ts packages/core/src/transform/openai-responses-types.ts packages/core/src/transform/openai-responses.test.ts packages/core/src/transform/openai-responses-compatibility.test.ts packages/core/src/transform/openai-responses-roundtrip.test.ts packages/core/src/egress/openai-responses/state.ts
rtk git commit -m "feat(core): preserve OpenAI Responses images" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Preserve OpenAI Chat User and Tool Images

**Files:**

- Move: `packages/core/src/transform/openai-completions.ts` → `packages/core/src/transform/openai-completions/openai-completions.ts`
- Move: `packages/core/src/transform/openai-completions-from-model.ts` → `packages/core/src/transform/openai-completions/openai-completions-from-model.ts`
- Move: `packages/core/_test/transform/openai-completions.test.ts` → `packages/core/src/transform/openai-completions/openai-completions.test.ts`
- Create: `packages/core/src/transform/openai-completions/index.ts`
- Modify: `packages/core/src/index.ts:161-171`

Use `apply_patch` move directives for the three moves. Do not leave compatibility files at the old paths.

**Interfaces:**

- Consumes: Task 2 `imageFilePart()` and marker.
- Produces: canonical Chat user images and `ToolResultPart.output.type === "content"` for array-valued tool images; reverse conversion emits the selected CPA-compatible Chat syntax.

- [x] **Step 1: Move the modules, repair exports, and add image preservation regressions**

First use `apply_patch` move directives for all three moves listed above. Then create `packages/core/src/transform/openai-completions/index.ts`:

```ts
export { modelMessagesToOpenAICompletions } from "./openai-completions-from-model";
export {
  type OpenAICompletionsFromModelMessages,
  type OpenAICompletionsModelMessages,
  type OpenAICompletionsTransformSettings,
  type OpenAICompletionsTransformTool,
  openAICompletionsToModelMessages,
} from "./openai-completions";
```

Replace the moved `openai-completions.ts` imports exactly:

```ts
import type { ModelMessage } from "../../ai-sdk-bridge";
import type { OpenAICompletionsRequest } from "../../ingress/openai-completions";

import { OpenAICompletionsTransformError } from "../../error";
import { imageFilePart } from "../../image-input";
```

Replace the moved `openai-completions-from-model.ts` imports exactly:

```ts
import type { FilePart, ModelMessage } from "../../ai-sdk-bridge";
import type { ImageInputDetail } from "../../image-input";
import type { OpenAICompletionsRequest } from "../../ingress/openai-completions";
import type { OpenAICompletionsFromModelMessages } from "./openai-completions";

import { OpenAICompletionsTransformError } from "../../error";
```

In `packages/core/src/index.ts`, add `modelMessagesToOpenAICompletions` to the existing `./transform/openai-completions` export block and delete this now-invalid export:

```ts
export { modelMessagesToOpenAICompletions } from "./transform/openai-completions-from-model";
```

After moving the test, change its imports to `../../index` and its fixture root to:

```ts
const fixtureRoot = `${import.meta.dir}/../../../_test/fixtures/openai-completions`;
```

Change `expectedRoundTrip()` so arrays retain `text` and `image_url` parts:

```ts
function expectedRoundTrip(request: OpenAICompletionsRequest): OpenAICompletionsRequest {
  return {
    ...request,
    tool_choice: undefined,
    max_tokens: undefined,
    max_completion_tokens: request.max_completion_tokens ?? request.max_tokens ?? undefined,
    messages: request.messages.map((message) =>
      Array.isArray(message.content)
        ? { ...message, content: message.content.filter((part) => part.type === "text" || part.type === "image_url") }
        : message,
    ),
  };
}
```

Replace `documents unsupported content part loss` with:

```ts
test("preserves conventional user image_url parts", async () => {
  const request = await readFixture("valid-content-parts.json");
  const converted = openAICompletionsToModelMessages(request);

  expect(converted.messages[0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "Describe this image." },
      {
        type: "file",
        mediaType: "image",
        data: { type: "url", url: new URL("https://example.com/image.png") },
      },
    ],
  });
  expect(
    modelMessagesToOpenAICompletions({ model: request.model, ...converted }).messages[0]?.content,
  ).toEqual(request.messages[0]?.content);
});
```

Add these two tests:

```ts
test("preserves ordered CPA image_url parts in tool content", () => {
  const request = parseOpenAICompletions({
    model: "gpt-5.6-sol",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
          { type: "text", text: "after" },
        ],
      },
    ],
  });

  const converted = openAICompletionsToModelMessages(request);
  expect(converted.messages[1]).toEqual({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "inspect",
        output: {
          type: "content",
          value: [
            { type: "text", text: "before" },
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "high" },
                aioProxy: { toolImage: true },
              },
            },
            { type: "text", text: "after" },
          ],
        },
      },
    ],
  });
  expect(modelMessagesToOpenAICompletions({ model: request.model, ...converted }).messages[1]).toEqual(
    request.messages[1],
  );
});

test("rejects a non-HTTP image_url instead of dropping it", () => {
  const request = parseOpenAICompletions({
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///tmp/image.png" } }] }],
  });

  expect(() => openAICompletionsToModelMessages(request)).toThrow(
    new OpenAICompletionsTransformError("messages.0.content.0.image_url.url"),
  );
});
```

Add the reverse provider-reference failure regression:

```ts
test("rejects an OpenAI file reference that Chat cannot encode", () => {
  expect(() =>
    modelMessagesToOpenAICompletions({
      model: "gpt-5.6-sol",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image",
              data: { type: "reference", reference: { openai: "file_123" } },
            },
          ],
        },
      ],
      settings: {},
    }),
  ).toThrow(new OpenAICompletionsTransformError("messages.0.content.0.data"));
});
```

Add `OpenAICompletionsTransformError` to the test imports. This regression forbids converting a Provider reference to text, dropping it, or guessing a URL.

- [x] **Step 2: Run the moved test and observe image loss**

Run:

```bash
rtk bun test packages/core/src/transform/openai-completions/openai-completions.test.ts
```

Expected: FAIL because user images are filtered and tool arrays become text-only output.

- [x] **Step 3: Replace the Chat ingress content mappers**

In the moved `openai-completions.ts`, the imports are already complete from Step 1. Replace the aliases below `AssistantPart` with these aliases:

```ts
type UserMessage = Extract<ModelMessage, { role: "user" }>;
type UserPart = Exclude<UserMessage["content"], string>[number];
type ContentPart = Extract<UserPart, { type: "file" | "text" }>;
type TextPart = Extract<AssistantPart, { type: "text" }>;
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResultPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
```

Replace `textContent`, `modelContent`, and the existing `textParts` with all four functions below. `textParts()` is deliberately text-only for system/developer/assistant messages; only user content and tool output call `contentParts()`:

```ts
function textContent(content: OpenAICompletionsRequest["messages"][number]["content"], path: string): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  return textParts(content, path)
    .map((part) => part.text)
    .join("");
}

function textParts(
  content: OpenAICompletionsRequest["messages"][number]["content"],
  path: string,
): TextPart[] {
  if (!Array.isArray(content)) {
    return typeof content === "string" && content !== "" ? [{ type: "text", text: content }] : [];
  }
  return content.flatMap((part, index) => {
    if (part.type === "text" && textKey in part && typeof part[textKey] === "string") {
      return [{ type: "text" as const, text: part[textKey] }];
    }
    if (part.type === "image_url") {
      throw new OpenAICompletionsTransformError(`${path}.${index}.type`);
    }
    return [];
  });
}

function modelContent(
  content: OpenAICompletionsRequest["messages"][number]["content"],
  path: string,
): string | ContentPart[] {
  return typeof content === "string" ? content : contentParts(content, path, false);
}

function contentParts(
  content: OpenAICompletionsRequest["messages"][number]["content"],
  path: string,
  toolResult: boolean,
): ContentPart[] {
  if (!Array.isArray(content)) {
    return typeof content === "string" && content !== "" ? [{ type: "text", text: content }] : [];
  }
  return content.flatMap((part, index) => {
    if (part.type === "text" && textKey in part && typeof part[textKey] === "string") {
      return [{ type: "text" as const, text: part[textKey] }];
    }
    if (part.type !== "image_url") return [];
    const payload = Reflect.get(part, "image_url");
    const url =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Reflect.get(payload, "url")
        : undefined;
    const detail =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? Reflect.get(payload, "detail")
        : undefined;
    if (typeof url !== "string" || (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high")) {
      throw new OpenAICompletionsTransformError(`${path}.${index}.image_url.url`);
    }
    const image = imageFilePart(
      { type: "url", url },
      { ...(detail === undefined ? {} : { detail }), toolResult },
    );
    if (image === undefined) throw new OpenAICompletionsTransformError(`${path}.${index}.image_url.url`);
    return [image];
  });
}

function toolOutput(
  content: OpenAICompletionsRequest["messages"][number]["content"],
  path: string,
): ToolResultPart["output"] {
  if (!Array.isArray(content)) return { type: "text", value: textContent(content, path) };
  const value = contentParts(content, path, true);
  if (value.every((part): part is TextPart => part.type === "text")) {
    return { type: "text", value: value.map((part) => part.text).join("") };
  }
  return { type: "content", value };
}
```

Replace the system, developer, and user cases exactly:

```ts
case "developer":
case "system":
  return { role: "system", content: textContent(message.content, `messages.${messageIndex}.content`) };
case "user":
  return { role: "user", content: modelContent(message.content, `messages.${messageIndex}.content`) };
```

Replace the complete assistant case with this code; retain the existing `parseToolInput()` helper unchanged:

```ts
case "assistant": {
  const contentPath = `messages.${messageIndex}.content`;
  const parts: AssistantPart[] = textParts(message.content, contentPath);
  for (const [toolIndex, toolCall] of (message.tool_calls ?? []).entries()) {
    const toolName = toolCall.function.name;
    if (toolName === undefined || toolName === "") {
      throw new OpenAICompletionsTransformError(
        `messages.${messageIndex}.tool_calls.${toolIndex}.function.name`,
      );
    }

    toolNames.set(toolCall.id, toolName);
    parts.push({
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName,
      input: parseToolInput(toolCall.function.arguments),
    });
  }

  return {
    role: "assistant",
    content: parts.length === 0 ? textContent(message.content, contentPath) : parts,
  };
}
```

Replace the complete tool case with:

```ts
case "tool":
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.tool_call_id,
        toolName: toolNames.get(message.tool_call_id) ?? "",
        output: toolOutput(message.content, `messages.${messageIndex}.content`),
      },
    ],
  };
```

- [x] **Step 4: Preserve images in the reverse Chat transform**

In the moved `openai-completions-from-model.ts`, imports are already complete from Step 1. Replace `openAIContent()` and add all three helpers below it:

```ts
function openAIContent(content: ModelMessage["content"], path: string) {
  if (typeof content === "string") return content;
  return content.flatMap((part, index) => {
    if (part.type === "text") return [{ type: "text" as const, text: part.text }];
    if (part.type === "file") return [imageUrlContent(part, `${path}.${index}`)];
    return [];
  });
}

function imageUrlContent(part: FilePart, path: string) {
  if (part.mediaType !== "image" && !part.mediaType.startsWith("image/")) {
    throw new OpenAICompletionsTransformError(`${path}.mediaType`);
  }
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new OpenAICompletionsTransformError(`${path}.data`);
  }
  const url =
    data.type === "url"
      ? data.url.toString()
      : data.type === "data" && typeof data.data === "string"
        ? `data:${part.mediaType};base64,${data.data}`
        : undefined;
  if (url === undefined) throw new OpenAICompletionsTransformError(`${path}.data`);
  const detail = openAIImageDetail(part);
  return {
    type: "image_url" as const,
    image_url: { url, ...(detail === undefined ? {} : { detail }) },
  };
}

function openAIImageDetail(part: FilePart): ImageInputDetail | undefined {
  const options = part.providerOptions?.openai;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  const detail = Reflect.get(options, "imageDetail");
  return detail === "auto" || detail === "low" || detail === "high" ? detail : undefined;
}

function toolContent(
  part: Extract<Extract<ModelMessage, { role: "tool" }>["content"][number], { type: "tool-result" }>,
  path: string,
) {
  if (part.output.type === "text") return part.output.value;
  if (part.output.type === "content") {
    return part.output.value.map((value, index) => {
      if (value.type === "text") return { type: "text" as const, text: value.text };
      if (value.type === "file") return imageUrlContent(value, `${path}.${index}`);
      throw new OpenAICompletionsTransformError(`${path}.${index}.type`);
    });
  }
  return "";
}
```

Update user and assistant calls to pass `messages.${messageIndex}.content`. The tool branch becomes:

```ts
case "tool": {
  const part = message.content[0];
  return {
    role: "tool",
    tool_call_id: part?.type === "tool-result" ? part.toolCallId : "",
    content:
      part?.type === "tool-result"
        ? toolContent(part, `messages.${messageIndex}.content.0.output.value`)
        : "",
  };
}
```

- [x] **Step 5: Run Chat tests, core tests, and checking**

Run:

```bash
rtk bun test packages/core/src/transform/openai-completions/openai-completions.test.ts
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run check
```

Expected: all commands exit 0; `valid-content-parts.json` round-trips with its image, string/text-only tool results remain `output.type === "text"`, and array tool images become marked content output.

- [x] **Step 6: Confirm no stale module paths remain**

Run:

```bash
rtk rg -n 'transform/openai-completions-from-model|_test/transform/openai-completions' packages/core packages/server
```

Expected: no output.

- [x] **Step 7: Commit Task 4**

```bash
rtk git add -A -- packages/core/src/transform/openai-completions packages/core/src/transform/openai-completions.ts packages/core/src/transform/openai-completions-from-model.ts packages/core/_test/transform/openai-completions.test.ts packages/core/src/index.ts
rtk git commit -m "feat(core): preserve OpenAI Chat images" -m "Co-authored-by: Codex <noreply@openai.com>"
```

`git add -A --` is required because the three old paths are deletions after the move.

### Task 5: Preserve Anthropic User and Tool-Result Images

**Files:**

- Move: `packages/core/src/ingress/anthropic-messages.ts` → `packages/core/src/ingress/anthropic-messages/anthropic-messages.ts`
- Move: `packages/core/_test/ingress/anthropic-messages.test.ts` → `packages/core/src/ingress/anthropic-messages/anthropic-messages.test.ts`
- Create: `packages/core/src/ingress/anthropic-messages/index.ts`
- Move: `packages/core/src/transform/anthropic-messages.ts` → `packages/core/src/transform/anthropic-messages/anthropic-messages.ts`
- Move: `packages/core/_test/transform/anthropic-messages.test.ts` → `packages/core/src/transform/anthropic-messages/anthropic-messages.test.ts`
- Create: `packages/core/src/transform/anthropic-messages/index.ts`
- Create: `packages/core/src/transform/anthropic-messages/anthropic-messages-images.test.ts`
- Modify: `packages/core/src/transform/anthropic-messages/to-model.ts`
- Modify: `packages/core/src/transform/anthropic-messages/types.ts`
- Move: `packages/core/src/protocol/anthropic-messages.ts` → `packages/core/src/protocol/anthropic-messages/anthropic-messages.ts`
- Move and split: `packages/core/_test/protocol/anthropic-messages.test.ts` → the two protocol test files locked above
- Create: `packages/core/src/protocol/anthropic-messages/index.ts`
- Modify: `packages/core/src/index.ts`

Use `apply_patch` move directives. The exact import rewrites and test boilerplate are specified below; do not mechanically add `../` to every import. In moved ingress and transform tests, import the public core surface from `../../index` and use fixture root `../../../_test/fixtures/anthropic-messages`.

**Interfaces:**

- Consumes: Task 2 `imageFilePart()` and its marker.
- Produces: Anthropic base64/URL image blocks as canonical file parts, including nested `tool_result.content`; the protocol adapter emits ordinary images as user messages and tool outputs as tool messages.

- [x] **Step 1: Add Anthropic ingress rejection and transform preservation tests**

In the moved ingress test, add these cases to `invalidInputs`:

```ts
{
  name: "image invalid base64",
  input: {
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "!" } }],
      },
    ],
  },
  path: ["messages", 0, "content", 0, "source", "data"],
},
{
  name: "image non-image MIME",
  input: {
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "application/pdf", data: "AA==" } },
        ],
      },
    ],
  },
  path: ["messages", 0, "content", 0, "source", "media_type"],
},
{
  name: "image non-HTTP URL",
  input: {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "url", url: "file:///tmp/image.png" } }] },
    ],
  },
  path: ["messages", 0, "content", 0, "source", "url"],
},
```

Create `packages/core/src/transform/anthropic-messages/anthropic-messages-images.test.ts` with these imports, then add both transform regressions below. Do not grow the moved 163-line general transform test:

```ts
import { expect, test } from "bun:test";

import {
  anthropicMessagesToModelMessages,
  modelMessagesToAnthropicMessages,
  parseAnthropicMessages,
} from "../../index";
```

Add this exact round-trip regression:

```ts
test("preserves ordered user and tool-result images as canonical file parts", () => {
  const request = parseAnthropicMessages({
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "inspect", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AA==" },
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
          { type: "text", text: "middle" },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "tool-before" },
              { type: "image", source: { type: "url", url: "https://example.test/result.png" } },
              { type: "text", text: "tool-after" },
            ],
          },
        ],
      },
    ],
  });

  const converted = anthropicMessagesToModelMessages(request);
  expect(converted.messages[1]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "before" },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: "AA==" },
        providerOptions: {
          anthropic: { cache_control: { type: "ephemeral", ttl: "5m" } },
        },
      },
      { type: "text", text: "middle" },
      {
        type: "tool-result",
        toolCallId: "toolu_1",
        toolName: "inspect",
        output: {
          type: "content",
          value: [
            { type: "text", text: "tool-before" },
            {
              type: "file",
              mediaType: "image",
              data: { type: "url", url: new URL("https://example.test/result.png") },
              providerOptions: { aioProxy: { toolImage: true } },
            },
            { type: "text", text: "tool-after" },
          ],
        },
      },
    ],
  });
  expect(modelMessagesToAnthropicMessages({ model: request.model, ...converted })).toEqual(request);
});
```

Add this separate normalization regression. A valid Anthropic URL source may be an image data URL; canonicalization intentionally emits it back as the equivalent native base64 source:

```ts
test("normalizes an Anthropic data URL image source to native base64", () => {
  const request = parseAnthropicMessages({
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "data:image/png;base64,AA==" } }],
      },
    ],
  });

  const converted = anthropicMessagesToModelMessages(request);
  expect(converted.messages).toEqual([
    {
      role: "user",
      content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "AA==" } }],
    },
  ]);
  expect(modelMessagesToAnthropicMessages({ model: request.model, ...converted })).toEqual({
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AA==" },
          },
        ],
      },
    ],
  });
});
```

- [x] **Step 2: Move and split the protocol test before adding coverage**

Move the complete current file to `anthropic-messages.test.ts`, then cut only the test block named `flushes user content on kind changes and preserves part provider options` from it into `anthropic-messages-images.test.ts`. The normal file keeps its existing imports, `request()` helper, `describe("anthropicMessagesAdapter", ...)` wrapper, stream loop, and four remaining tests.

Start `anthropic-messages-images.test.ts` with this exact independent prelude, then paste the complete moved test block immediately after it:

```ts
import { describe, expect, test } from "bun:test";

import { anthropicMessagesAdapter } from "../../index";

function request(body: object): Request {
  return new Request("https://proxy.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("anthropicMessagesAdapter image boundaries", () => {
```

Add this separate test after the moved test, then append one final `});` after it to close the `describe` wrapper:

```ts
test("keeps image runs in user messages and image tool results in tool messages", async () => {
  const parsed = await anthropicMessagesAdapter.parse(
    request({
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "inspect", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "result" },
                { type: "image", source: { type: "url", url: "https://example.test/result.png" } },
              ],
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    }),
    {},
  );

  expect(anthropicMessagesAdapter.modelInvocation(parsed, {}).messages.slice(1)).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "before" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: "AA==" } },
      ],
    },
    {
      role: "tool",
      content: [
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "toolu_1",
          output: {
            type: "content",
            value: [
              { type: "text", text: "result" },
              {
                type: "file",
                mediaType: "image",
                data: { type: "url", url: new URL("https://example.test/result.png") },
                providerOptions: { aioProxy: { toolImage: true } },
              },
            ],
          },
        }),
      ],
    },
    { role: "user", content: [{ type: "text", text: "after" }] },
  ]);
});
```

Each protocol test file must remain below 300 lines.

- [x] **Step 3: Run the moved tests and observe schema/transform failures**

Run:

```bash
rtk bun test packages/core/src/ingress/anthropic-messages/anthropic-messages.test.ts packages/core/src/transform/anthropic-messages/anthropic-messages.test.ts packages/core/src/transform/anthropic-messages/anthropic-messages-images.test.ts packages/core/src/protocol/anthropic-messages/anthropic-messages-images.test.ts
```

Expected: FAIL because `image` is not admitted and the user-message bridge treats every non-text part as a tool result.

- [x] **Step 4: Add the Anthropic image schemas and ingress barrel**

In the moved ingress implementation, add this exact relative import and add the schemas after `TextBlockSchema`:

```ts
import { imageFilePart, isImageMediaType, isValidBase64 } from "../../image-input";

const Base64ImageSourceSchema = z.object({
  type: z.literal("base64"),
  media_type: z.string().refine((value) => value !== "image" && isImageMediaType(value)),
  data: z.string().refine(isValidBase64),
});

const UrlImageSourceSchema = z.object({
  type: z.literal("url"),
  url: z.string().refine((url) => imageFilePart({ type: "url", url }) !== undefined),
});

const ImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [Base64ImageSourceSchema, UrlImageSourceSchema]),
  cache_control: CacheControlSchema.optional(),
});
```

Change the tool-result content and user union exactly:

```ts
const ToolResultContentBlockSchema = z.discriminatedUnion("type", [ToolResultTextBlockSchema, ImageBlockSchema]);

content: z.union([z.string(), z.array(ToolResultContentBlockSchema)]),

const UserContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ImageBlockSchema,
  ToolResultBlockSchema,
]);
```

Apply the new `content` type in both halves of the existing `ToolResultBlockSchema` pipeline. Export:

```ts
export type AnthropicImageBlock = z.output<typeof ImageBlockSchema>;
```

Do not invent an Anthropic provider-reference wire source: pinned `@anthropic-ai/sdk@0.111.0` permits base64 or URL for non-beta image blocks.

Create the ingress `index.ts` by moving the existing root exports there unchanged and adding `AnthropicImageBlock`. The simplest valid content is:

```ts
export * from "./anthropic-messages";
```

In the explicit ingress export block in `packages/core/src/index.ts`, add:

```ts
type AnthropicImageBlock,
```

This root export is mandatory; the root index does not use `export *` for this ingress module.

- [x] **Step 5: Widen the private Anthropic model types**

In `types.ts`, import `FilePart` and replace the affected unions:

```ts
import type { FilePart } from "../../ai-sdk-bridge";

export type ToolResultPart = {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output:
    | { readonly type: "text"; readonly value: string }
    | {
        readonly type: "content";
        readonly value: readonly (TextPart | FilePart)[];
      };
  readonly providerOptions?: AnthropicProviderOptions;
};

export type AnthropicUserMessage = {
  readonly role: "user";
  readonly content: string | readonly (TextPart | FilePart | ToolResultPart)[];
};
```

- [x] **Step 6: Convert Anthropic image blocks to canonical files**

In `to-model.ts`, add `FilePart` from `../../ai-sdk-bridge`, `AnthropicImageBlock` to the existing `../../ingress/anthropic-messages` type import, and `imageFilePart` from `../../image-input`.

Change the request loop and `messageToModelMessage()` so every image error gets the real inbound message index:

```ts
for (const [messageIndex, message] of request.messages.entries()) {
  messages.push(messageToModelMessage(message, toolNames, messageIndex));
}

function messageToModelMessage(
  message: AnthropicMessagesRequest["messages"][number],
  toolNames: Map<string, string>,
  messageIndex: number,
): AnthropicUserMessage | AnthropicAssistantMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: userContentToModelParts(message.content, toolNames, `messages.${messageIndex}.content`),
      };
    case "assistant":
      return { role: "assistant", content: assistantContentToModelParts(message.content, toolNames) };
    default:
      return assertNever(message);
  }
}
```

Replace `userContentToModelParts()` with this complete indexed implementation and include `FilePart` in its return union:

```ts
function userContentToModelParts(
  content: Extract<AnthropicMessagesRequest["messages"][number], { role: "user" }>["content"],
  toolNames: ReadonlyMap<string, string>,
  path: string,
): string | readonly (TextPart | FilePart | ToolResultPart)[] {
  return typeof content === "string"
    ? content
    : content.map((part, index) => {
        switch (part.type) {
          case "text":
            return textPart(part);
          case "image":
            return anthropicImagePart(part, `${path}.${index}`, false);
          case "tool_result":
            return toolResultPart(part, toolNames, `${path}.${index}`);
          default:
            return assertNever(part);
        }
      });
}
```

Use this complete helper:

```ts
function anthropicImagePart(part: AnthropicImageBlock, path: string, toolResult: boolean): FilePart {
  const image =
    part.source.type === "base64"
      ? imageFilePart(
          { type: "base64", mediaType: part.source.media_type, data: part.source.data },
          { toolResult },
        )
      : imageFilePart({ type: "url", url: part.source.url }, { toolResult });
  if (image === undefined) throw new AnthropicMessagesTransformError(path);
  if (part.cache_control === undefined) return image;
  return {
    ...image,
    providerOptions: {
      ...image.providerOptions,
      anthropic: { cache_control: part.cache_control },
    },
  };
}
```

Add `path: string` to `toolResultPart()`'s parameters and replace its array branch with this indexed mapper:

```ts
: {
    type: "content",
    value: part.content.map((contentPart, index) =>
      contentPart.type === "text"
        ? { type: "text", text: contentPart.text }
        : anthropicImagePart(contentPart, `${path}.content.${index}`, true),
    ),
  },
```

Keep string tool results as `output.type === "text"` and keep the outer tool result cache-control metadata unchanged.

- [x] **Step 7: Reverse canonical files back into Anthropic image blocks**

In the moved `anthropic-messages.ts`, import `FilePart` from `../../ai-sdk-bridge`; add `AnthropicImageBlock` to the ingress type import and `AnthropicProviderOptions` to the existing `./types` type import. Add `case "file"` to `userContentFromModelParts()` and call `imageBlock(part, `${path}.${index}`)`. Use this helper:

```ts
function imageBlock(part: FilePart, path: string): AnthropicImageBlock {
  if (part.mediaType !== "image" && !part.mediaType.startsWith("image/")) {
    throw new AnthropicMessagesTransformError(`${path}.mediaType`);
  }
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new AnthropicMessagesTransformError(`${path}.data`);
  }
  const source =
    data.type === "url"
      ? ({ type: "url", url: data.url.toString() } as const)
      : data.type === "data" && typeof data.data === "string" && part.mediaType !== "image"
        ? ({ type: "base64", media_type: part.mediaType, data: data.data } as const)
        : undefined;
  if (source === undefined) throw new AnthropicMessagesTransformError(`${path}.data`);
  const cacheControl = (part.providerOptions as AnthropicProviderOptions | undefined)?.anthropic?.cache_control;
  return {
    type: "image",
    source,
    ...(cacheControl === undefined ? {} : { cache_control: cacheControl }),
  };
}
```

Change `toolResultBlock()` to accept `path: string`, call it as `toolResultBlock(part, `${path}.${index}`)`, and replace its content-array mapping with:

```ts
part.output.value.map((contentPart, index) =>
  contentPart.type === "text"
    ? { type: "text" as const, text: contentPart.text }
    : imageBlock(contentPart, `${path}.content.${index}`),
)
```

Provider references must throw; they must never become text.

- [x] **Step 8: Fix the Anthropic protocol split**

Before editing the moved protocol implementation, apply these exact import-path rewrites:

```text
../ai-sdk-bridge                  -> ../../ai-sdk-bridge
../egress/anthropic-messages      -> ../../egress/anthropic-messages
../ingress/anthropic-messages     -> ../../ingress/anthropic-messages
../transform/anthropic-messages   -> ../../transform/anthropic-messages
./adapter                         -> ../adapter
./anthropic-thinking              -> ../anthropic-thinking
./errors                          -> ../errors
./request                         -> ../request
./session                         -> ../session
./tools                           -> ../tools
```

For the moved transform implementation, apply these exact rewrites and leave sibling `./types` and `./to-model` imports inside the directory:

```text
../ingress/anthropic-messages       -> ../../ingress/anthropic-messages
../error                            -> ../../error
./anthropic-messages/types          -> ./types
./anthropic-messages/to-model       -> ./to-model
```

The already nested `to-model.ts` and `types.ts` imports remain unchanged except for the new imports specified in Steps 5–6. Then replace the protocol's text-only aliases with:

```ts
type AnthropicUserPromptPart = Extract<AnthropicUserPart, { type: "file" | "text" }>;
```

Keep the existing string and empty-array early returns, then replace the remainder of `userMessages()` with this exact body, which uses `userParts` and discriminates only `tool-result`:

```ts
const messages: ModelMessage[] = [];
let userParts: ReturnType<typeof userPart>[] = [];
let toolResultParts: ReturnType<typeof toolResultPart>[] = [];

for (const part of content) {
  if (part.type === "tool-result") {
    if (userParts.length > 0) {
      messages.push({ role: "user", content: userParts });
      userParts = [];
    }
    toolResultParts.push(toolResultPart(part));
  } else {
    if (toolResultParts.length > 0) {
      messages.push({ role: "tool", content: toolResultParts });
      toolResultParts = [];
    }
    userParts.push(userPart(part));
  }
}

if (userParts.length > 0) messages.push({ role: "user", content: userParts });
if (toolResultParts.length > 0) messages.push({ role: "tool", content: toolResultParts });
return messages;
```

Add this copier and remove the old `textPart()`:

```ts
function userPart(part: AnthropicUserPromptPart) {
  return { ...part };
}
```

Create all three module barrels as export-only files:

```ts
export * from "./anthropic-messages";
```

- [x] **Step 9: Run all Anthropic behavior tests and checking**

Run:

```bash
rtk bun test packages/core/src/ingress/anthropic-messages packages/core/src/transform/anthropic-messages packages/core/src/protocol/anthropic-messages
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run check
```

Expected: all commands exit 0; base64/URL images round-trip, tool-image order is retained, and the protocol adapter splits only on tool-result boundaries.

- [x] **Step 10: Confirm legacy paths are gone and commit Task 5**

Run:

```bash
rtk rg -n '_test/(ingress|transform|protocol)/anthropic-messages|src/(ingress|protocol)/anthropic-messages\.ts|src/transform/anthropic-messages\.ts' packages/core
```

Expected: no output. Then commit:

```bash
rtk git add -A -- packages/core/src/ingress/anthropic-messages packages/core/src/transform/anthropic-messages packages/core/src/protocol/anthropic-messages packages/core/src/ingress/anthropic-messages.ts packages/core/src/transform/anthropic-messages.ts packages/core/src/protocol/anthropic-messages.ts packages/core/_test/ingress/anthropic-messages.test.ts packages/core/_test/transform/anthropic-messages.test.ts packages/core/_test/protocol/anthropic-messages.test.ts packages/core/src/index.ts
rtk git commit -m "feat(core): preserve Anthropic message images" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 6: Preserve Gemini File Data and Multimodal Function Responses

**Files:**

- Move: `packages/core/src/ingress/gemini-generate-content.ts` → `packages/core/src/ingress/gemini-generate-content/gemini-generate-content.ts`
- Move: `packages/core/_test/ingress/gemini-generate-content.test.ts` → `packages/core/src/ingress/gemini-generate-content/gemini-generate-content.test.ts`
- Create: `packages/core/src/ingress/gemini-generate-content/index.ts`
- Move: `packages/core/src/transform/gemini-generate-content.ts` → `packages/core/src/transform/gemini-generate-content/gemini-generate-content.ts`
- Move: `packages/core/src/transform/gemini-generate-content-from-model.ts` → `packages/core/src/transform/gemini-generate-content/gemini-generate-content-from-model.ts`
- Move: `packages/core/src/transform/gemini-generate-content-types.ts` → `packages/core/src/transform/gemini-generate-content/gemini-generate-content-types.ts`
- Move: `packages/core/_test/transform/gemini-generate-content.test.ts` → `packages/core/src/transform/gemini-generate-content/gemini-generate-content.test.ts`
- Create: `packages/core/src/transform/gemini-generate-content/index.ts`
- Create: `packages/core/_test/fixtures/gemini-generate-content/file-data-vision.json`
- Modify: `packages/core/_test/fixtures/gemini-generate-content/function-response-tools-safety.json`

Use `apply_patch` move directives. Apply these exact import-path rewrites after moving; do not mechanically rewrite sibling imports:

```text
ingress/gemini-generate-content.ts:
  ../error                              -> ../../error

transform/gemini-generate-content.ts:
  ../ai-sdk-bridge                      -> ../../ai-sdk-bridge
  ../ingress/gemini-generate-content    -> ../../ingress/gemini-generate-content
  ../error                              -> ../../error
  ./gemini-generate-content-types       -> ./gemini-generate-content-types (unchanged sibling)

transform/gemini-generate-content-from-model.ts:
  ../ai-sdk-bridge                      -> ../../ai-sdk-bridge
  ../ingress/gemini-generate-content    -> ../../ingress/gemini-generate-content
  ../error                              -> ../../error
  ./gemini-generate-content-types       -> ./gemini-generate-content-types (unchanged sibling)

transform/gemini-generate-content-types.ts:
  ../ai-sdk-bridge                      -> ../../ai-sdk-bridge
  ../ingress/gemini-generate-content    -> ../../ingress/gemini-generate-content
```

In moved tests, import from `../../index` and use fixture root `../../../_test/fixtures/gemini-generate-content`.

**Interfaces:**

- Consumes: Task 2 `imageFilePart()`, `isHttpUrl()`, `isImageMediaType()`, and `isValidBase64()`.
- Produces: canonical URL files for Gemini `fileData`, canonical marked tool images for `functionResponse.parts`, exact reverse wire mapping, and nested 20 MiB validation.

- [x] **Step 1: Add the fileData fixture and multimodal function response**

Create `file-data-vision.json` exactly:

```json
{
  "model": "gemini-2.5-flash",
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "Describe this remote image." },
        {
          "fileData": {
            "mimeType": "image/png",
            "fileUri": "https://example.test/image.png"
          }
        }
      ]
    }
  ]
}
```

Add this property beside `response` inside the existing function response fixture:

```json
"parts": [
  {
    "inlineData": {
      "mimeType": "image/png",
      "data": "AA=="
    }
  }
]
```

Add `file-data-vision.json` to both moved test files' `validFixtures` arrays.

- [x] **Step 2: Add the failing Gemini transform assertions**

In the moved transform test, add:

```ts
test("converts fileData URLs to canonical URL file parts", async () => {
  const request = await readFixture("file-data-vision.json");
  const converted = geminiGenerateContentToModelMessages(request);

  expect(converted.messages[0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "Describe this remote image." },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "url", url: new URL("https://example.test/image.png") },
      },
    ],
  });
  expect(modelMessagesToGeminiGenerateContent({ model: request.model, ...converted })).toEqual(request);
});
```

Update the existing function-response assertion so its output is:

```ts
output: {
  type: "content",
  value: [
    {
      type: "text",
      text: JSON.stringify({ temperature: "18C", condition: "rain" }),
    },
    {
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: "AA==" },
      providerOptions: { aioProxy: { toolImage: true } },
    },
  ],
},
```

The existing round-trip loop must continue to cover the modified fixture exactly.

- [x] **Step 3: Add the nested inline-size regression**

In the moved ingress test, add:

```ts
test("rejects oversize inlineData nested in functionResponse.parts", () => {
  const data = "A".repeat(Math.ceil((inlineLimitBytes + 1) / 3) * 4);
  const result = safeParseGeminiGenerateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "inspect",
              response: { ok: true },
              parts: [{ inlineData: { mimeType: "image/png", data } }],
            },
          },
        ],
      },
    ],
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(GeminiInlineDataTooLargeError);
    expect(result.error.status).toBe(413);
    expect(result.error.path).toBe("contents.0.parts.0.functionResponse.parts.0.inlineData.data");
  }
});
```

- [x] **Step 4: Run the moved tests and observe schema failures**

Run:

```bash
rtk bun test packages/core/src/ingress/gemini-generate-content/gemini-generate-content.test.ts packages/core/src/transform/gemini-generate-content/gemini-generate-content.test.ts
```

Expected: FAIL because `fileData` and `functionResponse.parts` are rejected.

- [x] **Step 5: Extend and validate the Gemini part schemas**

In the moved ingress implementation, import the Task 2 validators. Change `inlineDataSchema.data` to `z.string().min(1).refine(isValidBase64)`, then add:

```ts
import { isHttpUrl, isImageMediaType, isValidBase64 } from "../../image-input";

const fileDataSchema = z.object({
  mimeType: z.string().refine((value) => value !== "image" && isImageMediaType(value)),
  fileUri: z.string().refine(isHttpUrl),
});

const functionResponseInlineDataSchema = inlineDataSchema.extend({
  mimeType: z.string().refine((value) => value !== "image" && isImageMediaType(value)),
});

const functionResponsePartSchema = z
  .object({
    inlineData: functionResponseInlineDataSchema,
  })
  .strict();

const functionResponseSchema = z.object({
  name: idSchema,
  response: z.unknown(),
  parts: z.array(functionResponsePartSchema).min(1).optional(),
});
```

Add `fileData: fileDataSchema.optional()` to `partSchema` and include `part.fileData` in its exact-one count. Do not count nested `functionResponse.parts` as a top-level variant.

- [x] **Step 6: Reuse the existing 20 MiB guard for nested data**

Extract this private checker below `inlineDataTooLarge()`:

```ts
function oversizedInlineData(data: string, path: string): GeminiInlineDataTooLargeError | undefined {
  const actualBytes = base64ByteLength(data);
  return actualBytes > inlineDataLimitBytes
    ? new GeminiInlineDataTooLargeError(path, inlineDataLimitBytes, actualBytes)
    : undefined;
}
```

Replace the inner body of `inlineDataTooLarge()` with:

```ts
if (part.inlineData !== undefined) {
  const error = oversizedInlineData(
    part.inlineData.data,
    `contents.${contentIndex}.parts.${partIndex}.inlineData.data`,
  );
  if (error !== undefined) return error;
}
for (const [responsePartIndex, responsePart] of (part.functionResponse?.parts ?? []).entries()) {
  const error = oversizedInlineData(
    responsePart.inlineData.data,
    `contents.${contentIndex}.parts.${partIndex}.functionResponse.parts.${responsePartIndex}.inlineData.data`,
  );
  if (error !== undefined) return error;
}
```

Do not change `inlineDataLimitBytes`.

- [x] **Step 7: Convert Gemini inbound fileData and function-response images**

In the moved transform implementation, import `FilePart` with `ModelMessage`, and import `imageFilePart` plus `isImageMediaType` from `../../image-input`. Add this alias:

```ts
type InlineData = NonNullable<GeminiPart["inlineData"]>;
```

Use this helper for tool images:

```ts
function inlineDataFile(inlineData: InlineData, path: string, toolResult: boolean): FilePart {
  const image = imageFilePart(
    { type: "base64", mediaType: inlineData.mimeType, data: inlineData.data },
    { toolResult },
  );
  if (image === undefined) throw new GeminiGenerateContentTransformError(path);
  return image;
}
```

In `contentToMessage()`, replace the user mapping with an indexed call:

```ts
return {
  role: "user",
  content: content.parts.map((part, partIndex) => userPart(part, contentIndex, partIndex)),
};
```

Replace `userPart()` completely. This retains the existing non-image inline-data behavior while routing actual images through the canonical validator, and gives every failure a real structural path:

```ts
function userPart(part: GeminiPart, contentIndex: number, partIndex: number): UserPart {
  const path = `contents.${contentIndex}.parts.${partIndex}`;
  if (part.text !== undefined) {
    return { type: "text", text: part.text };
  }
  if (part.inlineData !== undefined) {
    if (isImageMediaType(part.inlineData.mimeType)) {
      return inlineDataFile(part.inlineData, `${path}.inlineData`, false);
    }
    return {
      type: "file",
      mediaType: part.inlineData.mimeType,
      data: { type: "data", data: part.inlineData.data },
    };
  }
  if (part.fileData !== undefined) {
    const image = imageFilePart({
      type: "url",
      url: part.fileData.fileUri,
      mediaType: part.fileData.mimeType,
    });
    if (image === undefined) throw new GeminiGenerateContentTransformError(`${path}.fileData`);
    return image;
  }
  throw new GeminiGenerateContentTransformError(path);
}
```

Replace `toolResultPart()` output construction with:

```ts
const text = { type: "text" as const, text: JSON.stringify(response.response) ?? "" };
const images = (response.parts ?? []).map((responsePart, responsePartIndex) =>
  inlineDataFile(
    responsePart.inlineData,
    `contents.${contentIndex}.parts.${partIndex}.functionResponse.parts.${responsePartIndex}.inlineData`,
    true,
  ),
);

return {
  type: "tool-result",
  toolCallId: `gemini-response-${response.name}-${contentIndex}-${partIndex}`,
  toolName: response.name,
  output: images.length === 0 ? { type: "text", value: text.text } : { type: "content", value: [text, ...images] },
};
```

This keeps the old text output contract when no image exists.

- [x] **Step 8: Reverse URL/data files and multimodal function responses**

In the moved `gemini-generate-content-from-model.ts`, add this value import after the existing type imports:

```ts
import { isImageMediaType } from "../../image-input";
```

Then replace the user file branch with:

```ts
if (part.type === "file") return geminiFilePart(part, `${path}.content.${index}`);
```

Replace `fileData()` with:

```ts
function geminiFilePart(part: FilePart, path: string): GeminiPart {
  const data = part.data;
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new GeminiGenerateContentTransformError(`${path}.data`);
  }
  if (data.type === "url") {
    return { fileData: { mimeType: part.mediaType, fileUri: data.url.toString() } };
  }
  if (data.type === "data" && typeof data.data === "string") {
    return { inlineData: { mimeType: part.mediaType, data: data.data } };
  }
  throw new GeminiGenerateContentTransformError(`${path}.data`);
}
```

Define this request-derived alias beside `ToolPart` so the function-response wire type stays synchronized with the Zod schema:

```ts
type GeminiFunctionResponse = NonNullable<GeminiPart["functionResponse"]>;
```

Change `functionResponsePart()` to receive its path and use:

```ts
function functionResponsePart(part: ToolPart, path: string): GeminiPart {
  const output = functionResponseOutput(part.output, path);
  return {
    functionResponse: {
      name: part.toolName,
      response: output.response,
      ...(output.parts === undefined ? {} : { parts: output.parts }),
    },
  };
}

function functionResponseOutput(
  output: ToolPart["output"],
  path: string,
): {
  readonly response: unknown;
  readonly parts?: GeminiFunctionResponse["parts"];
} {
  if (output.type !== "content") return { response: toolOutput(output) };
  const text = output.value.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const parts = output.value.flatMap((part, index) => {
    if (part.type === "text") return [];
    if (part.type !== "file") {
      throw new GeminiGenerateContentTransformError(`${path}.value.${index}.type`);
    }
    if (part.mediaType === "image" || !isImageMediaType(part.mediaType)) {
      throw new GeminiGenerateContentTransformError(`${path}.value.${index}.mediaType`);
    }
    const data = part.data;
    if (
      typeof data !== "object" ||
      data === null ||
      !("type" in data) ||
      data.type !== "data" ||
      typeof data.data !== "string"
    ) {
      throw new GeminiGenerateContentTransformError(`${path}.value.${index}.data`);
    }
    return [{ inlineData: { mimeType: part.mediaType, data: data.data } }];
  });
  return {
    response: parseJson(text),
    ...(parts.length === 0 ? {} : { parts }),
  };
}
```

Define this alias beside `ToolPart`, then change `toolOutput()` to the complete non-content-only implementation below. This makes the switch exhaustive without pretending the `content` member disappeared from `ToolPart["output"]`:

```ts
type NonContentToolOutput = Exclude<ToolPart["output"], { type: "content" }>;

function toolOutput(output: NonContentToolOutput): unknown {
  switch (output.type) {
    case "text":
      return parseJson(output.value);
    case "json":
      return output.value;
    case "execution-denied":
      return { error: output.reason ?? "execution denied" };
    case "error-text":
      return { error: output.value };
    case "error-json":
      return output.value;
    default:
      return assertNever(output);
  }
}
```

Remove the old `toolOutput(part: ToolPart)` function in full. Pass the precise path from `messageToContent()`:

```ts
return functionResponsePart(part, `messages.${index}.content.${partIndex}.output`);
```

Remote tool-result URLs must throw here. They are handled as candidate-level incompatibility by Task 9, not downloaded or stringified.

- [x] **Step 9: Create export-only barrels**

Create ingress `index.ts`:

```ts
export * from "./gemini-generate-content";
```

Create transform `index.ts`:

```ts
export { modelMessagesToGeminiGenerateContent } from "./gemini-generate-content-from-model";
export { geminiGenerateContentToModelMessages } from "./gemini-generate-content";
export type {
  GeminiGenerateContentFromModelMessages,
  GeminiGenerateContentModelMessages,
  GeminiGenerateContentSettings,
  GeminiGenerateContentTool,
} from "./gemini-generate-content-types";
```

Remove both old re-export blocks (`modelMessagesToGeminiGenerateContent` and the four public types) from inside the moved implementation so the barrel is the only public entry.

- [x] **Step 10: Run Gemini tests and checking**

Run:

```bash
rtk bun test packages/core/src/ingress/gemini-generate-content packages/core/src/transform/gemini-generate-content
rtk bun run --filter @aio-proxy/core test:unit
rtk bun run check
```

Expected: all commands exit 0; both fixtures round-trip exactly, and nested oversized data returns the existing 413-capable error with the nested path.

- [x] **Step 11: Confirm legacy paths are gone and commit Task 6**

Run:

```bash
rtk rg -n '_test/(ingress|transform)/gemini-generate-content|src/(ingress|transform)/gemini-generate-content(-from-model|-types)?\.ts' packages/core
```

Expected: no output. Then commit:

```bash
rtk git add -A -- packages/core/src/ingress/gemini-generate-content packages/core/src/transform/gemini-generate-content packages/core/src/ingress/gemini-generate-content.ts packages/core/src/transform/gemini-generate-content.ts packages/core/src/transform/gemini-generate-content-from-model.ts packages/core/src/transform/gemini-generate-content-types.ts packages/core/_test/ingress/gemini-generate-content.test.ts packages/core/_test/transform/gemini-generate-content.test.ts packages/core/_test/fixtures/gemini-generate-content
rtk git commit -m "feat(core): preserve Gemini image inputs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 7: Lock the Three Native AI SDK Tool-Image Wire Shapes

**Files:**

- Create: `packages/core/src/image-input/sdk-wire.test.ts`

**Interfaces:**

- Consumes: the marked canonical file shape from Tasks 2–6 and the pinned provider packages.
- Produces: black-box evidence that the installed OpenAI Responses, Anthropic, and Gemini encoders retain images visually. No production API is added.

- [x] **Step 1: Add one captured request per native target**

Create `sdk-wire.test.ts` exactly as follows:

```ts
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { expect, test } from "bun:test";

const prompt = [
  {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "inspect", input: {} }],
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "call_1",
        toolName: "inspect",
        output: {
          type: "content" as const,
          value: [
            { type: "text" as const, text: "before" },
            {
              type: "file" as const,
              mediaType: "image/png",
              data: { type: "data" as const, data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "low" },
                aioProxy: { toolImage: true },
              },
            },
          ],
        },
      },
    ],
  },
] satisfies LanguageModelV4CallOptions["prompt"];

test("OpenAI Responses emits input_image inside function_call_output", async () => {
  const capture = requestCapture();
  const model = createOpenAI({ apiKey: "test", fetch: capture.fetch }).responses("gpt-5.6-sol");

  const body = await capture.generate(model);

  expect(body).toEqual({
    model: "gpt-5.6-sol",
    input: [
      { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "before" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
        ],
      },
    ],
  });
});

test("Anthropic emits image inside tool_result content", async () => {
  const capture = requestCapture();
  const model = createAnthropic({ apiKey: "test", fetch: capture.fetch }).languageModel("claude-sonnet-4-5");

  const body = await capture.generate(model);

  expect(body).toMatchObject({
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "inspect", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "before" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
            ],
          },
        ],
      },
    ],
  });
});

test("Gemini 3 emits inlineData inside functionResponse.parts", async () => {
  const capture = requestCapture();
  const model = createGoogleGenerativeAI({ apiKey: "test", fetch: capture.fetch }).languageModel(
    "gemini-3-flash-preview",
  );

  const body = await capture.generate(model);

  expect(body).toEqual({
    generationConfig: {},
    contents: [
      {
        role: "model",
        parts: [
          {
            functionCall: { id: "call_1", name: "inspect", args: {} },
            thoughtSignature: "skip_thought_signature_validator",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_1",
              name: "inspect",
              response: { name: "inspect", content: "before" },
              parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }],
            },
          },
        ],
      },
    ],
  });
});

function requestCapture(): {
  readonly fetch: typeof globalThis.fetch;
  readonly generate: (model: LanguageModelV4) => Promise<unknown>;
} {
  let body: unknown;
  const captureError = new Error("request captured");
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(String(init?.body));
    throw captureError;
  };
  return {
    fetch: fetcher as typeof globalThis.fetch,
    async generate(model) {
      try {
        await model.doGenerate({ prompt });
      } catch (error) {
        if (!hasCause(error, captureError)) throw error;
      }
      if (body === undefined) throw new Error("provider did not issue a request");
      return body;
    },
  };
}

function hasCause(error: unknown, target: Error): boolean {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current === target) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
```

Do not mock the provider converter. The fake fetch is the boundary under test. The OpenAI Responses case is specifically the client-tool `role: "tool"` path that becomes `function_call_output`; do not replace it with a provider-executed assistant tool-result fixture, whose SDK encoding contract is different.

- [x] **Step 2: Run the black-box SDK test**

Run:

```bash
rtk bun test packages/core/src/image-input/sdk-wire.test.ts
```

Expected: PASS. If a pinned SDK body differs, stop Task 7 and report the complete captured request body plus the exact differing fields. Do not modify the assertion, production code, design, or this plan until that difference has an explicit design decision; in particular, do not loosen an image assertion to `toBeDefined()`.

- [x] **Step 3: Run core tests and commit Task 7**

```bash
rtk bun run --filter @aio-proxy/core test:unit
rtk git add packages/core/src/image-input/sdk-wire.test.ts
rtk git commit -m "test(core): lock native tool image encodings" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 8: Emit the CPA Tool-Image Extension on Compatible Model Paths

**Files:**

- Modify: `packages/plugin-sdk/src/openai-stream/openai-stream-fetch.ts`
- Create: `packages/plugin-sdk/src/openai-stream/tool-images.test.ts`
- Modify: `packages/plugin-sdk/src/openai-stream/index.ts`
- Modify: `packages/core/src/provider/openai-stream-fetch.ts`
- Modify: `packages/core/src/provider/api/api-openai-stream.test.ts`
- Create: `packages/core/src/provider/ai-sdk/ai-sdk-tool-images.test.ts`
- Create: `packages/core/src/provider/api-bridge/api-bridge-tool-images.test.ts`
- Move: `packages/plugins/github-copilot/src/runtime.ts` → `packages/plugins/github-copilot/src/runtime/runtime.ts`
- Move: `packages/plugins/github-copilot/_test/runtime.test.ts` → `packages/plugins/github-copilot/src/runtime/runtime.test.ts`
- Create: `packages/plugins/github-copilot/src/runtime/index.ts`
- Create: `packages/plugins/github-copilot/src/runtime/tool-images.test.ts`
- Move: `packages/plugins/kimi-code/src/runtime.ts` → `packages/plugins/kimi-code/src/runtime/runtime.ts`
- Move: `packages/plugins/kimi-code/src/runtime.test.ts` → `packages/plugins/kimi-code/src/runtime/runtime.test.ts`
- Create: `packages/plugins/kimi-code/src/runtime/index.ts`
- Create: `packages/plugins/kimi-code/src/runtime/tool-images.test.ts`

**Interfaces:**

- Consumes: Task 2 marker after `@ai-sdk/openai-compatible` JSON-stringifies a canonical tool content array.
- Produces: CPA wire `role: "tool", content: [{ type: "image_url", image_url: { url, detail? } }]` for configured compatible providers, API bridges, GitHub Copilot, and Kimi Code. Raw requests remain byte-semantically unmodified.

- [x] **Step 1: Add focused fetch-wrapper regressions**

Create `packages/plugin-sdk/src/openai-stream/tool-images.test.ts` with this header, followed by the three tests below, then one final `});` to close the wrapper:

```ts
import { describe, expect, test } from "bun:test";

import { createOpenAIStreamFetch } from "./openai-stream-fetch";

describe("createOpenAIStreamFetch tool images", () => {
```

Add these two tests inside that wrapper:

```ts
test("rewrites marked SDK tool content to ordered CPA image_url parts", async () => {
  let captured: Request | undefined;
  const fetch = createOpenAIStreamFetch(
    "openai-compatible",
    async (input, init) => {
      captured = new Request(input, init);
      return Response.json({ ok: true });
    },
    { rewriteToolImages: true },
  );
  const body = {
    model: "gpt-test",
    temperature: 0.2,
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify([
          { type: "text", text: "before" },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "AA==" },
            providerOptions: {
              openai: { imageDetail: "high" },
              aioProxy: { toolImage: true },
            },
          },
          {
            type: "file",
            mediaType: "image",
            data: { type: "url", url: "https://example.test/second.png" },
            providerOptions: { aioProxy: { toolImage: true } },
          },
          { type: "text", text: "after" },
        ]),
      },
    ],
  };

  await fetch("https://example.test/v1/chat/completions?trace=1", {
    method: "POST",
    headers: {
      "content-encoding": "gzip",
      "content-length": "999",
      "content-type": "application/json",
      "x-client": "kept",
    },
    body: JSON.stringify(body),
  });

  expect(captured?.url).toBe("https://example.test/v1/chat/completions?trace=1");
  expect(captured?.headers.get("content-encoding")).toBeNull();
  expect(captured?.headers.get("content-length")).toBeNull();
  expect(captured?.headers.get("x-client")).toBe("kept");
  expect(await captured?.json()).toEqual({
    model: "gpt-test",
    temperature: 0.2,
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
          { type: "image_url", image_url: { url: "https://example.test/second.png" } },
          { type: "text", text: "after" },
        ],
      },
    ],
  });
});

test("does not reinterpret unmarked JSON or rewrite a raw-compatible request", async () => {
  const captured: unknown[] = [];
  const upstream = async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push(await new Request(input, init).json());
    return Response.json({ ok: true });
  };
  const unmarked = {
    model: "gpt-test",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify([{ type: "file", mediaType: "image/png", data: { type: "data", data: "AA==" } }]),
      },
    ],
  };
  const modelFetch = createOpenAIStreamFetch("openai-compatible", upstream, { rewriteToolImages: true });
  const rawFetch = createOpenAIStreamFetch("openai-compatible", upstream);

  await modelFetch("https://example.test/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unmarked),
  });
  await rawFetch("https://example.test/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...unmarked, raw: true }),
  });

  expect(captured).toEqual([unmarked, { ...unmarked, raw: true }]);
});

test("fails a marked array containing an unsupported part", async () => {
  const fetch = createOpenAIStreamFetch(
    "openai-compatible",
    async () => {
      throw new Error("upstream must not run");
    },
    { rewriteToolImages: true },
  );
  const body = {
    model: "gpt-test",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify([
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "AA==" },
            providerOptions: { aioProxy: { toolImage: true } },
          },
          { type: "custom", value: "must not be flattened" },
        ]),
      },
    ],
  };

  await expect(
    fetch("https://example.test/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ).rejects.toThrow("Marked tool image content contains an unsupported part");
});
```

Both calls pass the wrapper's real JSON gate; the absence of a rewrite must come from the missing marker or opt-in, not from a missing header.

- [x] **Step 2: Run the wrapper tests and observe the missing option**

Run:

```bash
rtk bun test packages/plugin-sdk/src/openai-stream/tool-images.test.ts
```

Expected: FAIL because the third argument and rewrite do not exist.

- [x] **Step 3: Add the opt-in model-path rewrite**

Add this exported option type and update the function signature:

```ts
export type OpenAIStreamFetchOptions = {
  readonly rewriteToolImages?: boolean;
};

export function createOpenAIStreamFetch(
  protocol: OpenAIStreamProtocol,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  options: OpenAIStreamFetchOptions = {},
): typeof globalThis.fetch {
```

Update `packages/plugin-sdk/src/openai-stream/index.ts` to export the new public option type:

```ts
export {
  createOpenAIStreamFetch,
  type OpenAIStreamFetchOptions,
  type OpenAIStreamProtocol,
} from "./openai-stream-fetch";
```

At the beginning of `streamFetch`, replace the current request creation with:

```ts
const initialRequest = new Request(input, init);
const request =
  protocol === "openai-compatible" && options.rewriteToolImages === true
    ? await rewriteCompatibleToolImages(initialRequest)
    : initialRequest;
```

Add these private helpers before `isEventStream()`:

```ts
async function rewriteCompatibleToolImages(request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    !url.pathname.endsWith("/chat/completions") ||
    !request.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    return request;
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return request;
  }
  if (!isRecord(body) || !Array.isArray(body.messages)) return request;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!isRecord(message) || message.role !== "tool" || typeof message.content !== "string") return message;
    const content = compatibleToolContent(message.content);
    if (content === undefined) return message;
    changed = true;
    return { ...message, content };
  });
  if (!changed) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Request(request, { headers, body: JSON.stringify({ ...body, messages }) });
}

function compatibleToolContent(content: string): readonly unknown[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || !value.some(isMarkedToolImage)) return undefined;
  return value.map((part) => {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (isMarkedToolImage(part)) return compatibleImagePart(part);
    throw new TypeError("Marked tool image content contains an unsupported part");
  });
}

function isMarkedToolImage(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || value.type !== "file" || !isRecord(value.providerOptions)) return false;
  const aioProxy = value.providerOptions.aioProxy;
  return isRecord(aioProxy) && aioProxy.toolImage === true;
}

function compatibleImagePart(part: Readonly<Record<string, unknown>>) {
  const mediaType = part.mediaType;
  const data = part.data;
  if (
    typeof mediaType !== "string" ||
    (mediaType !== "image" && !mediaType.startsWith("image/")) ||
    !isRecord(data)
  ) {
    throw new TypeError("Marked tool image is invalid");
  }
  const url =
    data.type === "data" && typeof data.data === "string"
      ? `data:${mediaType};base64,${data.data}`
      : data.type === "url" && typeof data.url === "string"
        ? data.url
        : undefined;
  if (url === undefined) throw new TypeError("Marked tool image source is unsupported");
  const openAI = isRecord(part.providerOptions) ? part.providerOptions.openai : undefined;
  const detail = isRecord(openAI) ? openAI.imageDetail : undefined;
  if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
    throw new TypeError("Marked tool image detail is invalid");
  }
  return {
    type: "image_url" as const,
    image_url: { url, ...(detail === undefined ? {} : { detail }) },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

The rewritten body is created from parsed JSON only after an internal marker is found. Do not scan or rewrite arbitrary strings globally.

If a marked array contains any part other than valid text or a valid marked image, `compatibleToolContent()` must keep throwing `TypeError`. Do not convert that error to `ImageInputUnsupportedError` or an inbound 4xx/501. It is a model-path/provider failure and must continue through the existing `AiSdkProviderError` handling so the candidate loop can try the next Provider.

- [x] **Step 4: Opt in only from AI SDK compatible package paths**

In `packages/core/src/provider/openai-stream-fetch.ts`, change only the compatible package branch:

```ts
if (packageName === "@ai-sdk/openai-compatible") {
  return createOpenAIStreamFetch("openai-compatible", fetcher ?? globalThis.fetch, {
    rewriteToolImages: true,
  });
}
```

Leave `wrapOpenAIProtocolFetch()` unchanged so configured API raw passthrough does not opt in. The API bridge reaches the opt-in branch through its synthesized `@ai-sdk/openai-compatible` package.

In `packages/core/src/provider/api/api-openai-stream.test.ts`, add this real raw-wiring regression inside the existing `describe` block. It sends an internal-looking marker deliberately and proves `createApiProvider()` still does not enable the model-only rewrite:

```ts
test("preserves marked tool content on compatible raw passthrough", async () => {
  let upstreamRequest: Request | undefined;
  const provider = createApiProvider(
    {
      kind: "api",
      id: "compatible-raw",
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: "https://upstream.test/v1",
    },
    {
      fetch: async (input, init) => {
        upstreamRequest = new Request(input, init);
        return Response.json({ ok: true });
      },
    },
  );
  const body = {
    model: "gpt-test",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify([
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "AA==" },
            providerOptions: { aioProxy: { toolImage: true } },
          },
        ]),
      },
    ],
  };

  await provider.passthrough(
    new Request("https://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  expect(await upstreamRequest?.json()).toEqual(body);
});
```

- [x] **Step 5: Add configured-provider and API-bridge assertions**

Create `packages/core/src/provider/ai-sdk/ai-sdk-tool-images.test.ts` exactly. This keeps the existing 201-line general test focused and below the 300-line limit:

```ts
import type { ProviderV3 } from "@ai-sdk/provider";

import { expect, test } from "bun:test";

import type { AiSdkProviderLoadOptions } from "../../index";

import { createAiSdkProvider } from "../../index";

const availableProvider = {
  languageModel() {
    throw new Error("languageModel should not be called by ensureAvailable");
  },
} satisfies Pick<ProviderV3, "languageModel">;

test("configured compatible provider rewrites marked tool images", async () => {
  let optionsSeen: AiSdkProviderLoadOptions | undefined;
  let upstreamRequest: Request | undefined;
  const provider = createAiSdkProvider(
    {
      kind: "ai-sdk",
      id: "compatible",
      packageName: "@ai-sdk/openai-compatible",
      options: { apiKey: "test", baseURL: "https://upstream.test/v1" },
    },
    {
      fetch: async (input, init) => {
        upstreamRequest = new Request(input, init);
        return Response.json({ ok: true });
      },
      async loadProvider(_packageName, options) {
        optionsSeen = options;
        return availableProvider;
      },
    },
  );
  await provider.ensureAvailable?.();

const sdkBody = {
  model: "gpt-test",
  messages: [
    {
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify([
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: "AA==" },
          providerOptions: { aioProxy: { toolImage: true } },
        },
      ]),
    },
  ],
};

  const modelFetch = optionsSeen?.fetch;
  if (typeof modelFetch !== "function") throw new Error("compatible model fetch was not installed");
  await modelFetch("https://upstream.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sdkBody),
  });

  expect(await upstreamRequest?.json()).toEqual({
    model: "gpt-test",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
      },
    ],
  });
});
```

Create `packages/core/src/provider/api-bridge/api-bridge-tool-images.test.ts` exactly. This is a separate bridge-wiring contract, not another unit test of `wrapOpenAIPackageFetch()`:

```ts
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import type { AiSdkProviderLoadOptions } from "../../index";

import { bridgeApiProviderToAiSdk } from "../../index";
import { loadedProvider, model } from "./api-bridge-test-helpers";

test("compatible API bridge rewrites marked tool images", async () => {
  let optionsSeen: AiSdkProviderLoadOptions | undefined;
  let upstreamRequest: Request | undefined;
  const bridge = bridgeApiProviderToAiSdk(
    {
      kind: ProviderKind.Api,
      id: "compatible-api",
      protocol: ProviderProtocol.OpenAICompatible,
      apiKey: "test",
      baseURL: "https://upstream.test/v1",
      models: ["gpt-test"],
    },
    {
      fetch: async (input, init) => {
        upstreamRequest = new Request(input, init);
        return Response.json({ ok: true });
      },
      async loadProvider(_packageName, options) {
        optionsSeen = options;
        return loadedProvider({ languageModel: (modelId) => model(modelId, "ok") });
      },
    },
  );
  await bridge?.ensureAvailable?.();

  const sdkBody = {
    model: "gpt-test",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify([
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "AA==" },
            providerOptions: { aioProxy: { toolImage: true } },
          },
        ]),
      },
    ],
  };
  const modelFetch = optionsSeen?.fetch;
  if (typeof modelFetch !== "function") throw new Error("bridge model fetch was not installed");
  await modelFetch("https://upstream.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sdkBody),
  });

  expect(await upstreamRequest?.json()).toEqual({
    model: "gpt-test",
    messages: [
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
      },
    ],
  });
});
```

- [x] **Step 6: Wrap only the GitHub Copilot compatible delegate**

Move the GitHub runtime source and legacy test to the paths in the Files list. Create `packages/plugins/github-copilot/src/runtime/index.ts`:

```ts
export * from "./runtime";
```

In moved `runtime.ts`, change `./github-api` to `../github-api`, import `createOpenAIStreamFetch` from `@aio-proxy/plugin-sdk/openai-stream`, and immediately after `dynamicFetch` add:

```ts
const compatibleFetch = createOpenAIStreamFetch("openai-compatible", dynamicFetch, {
  rewriteToolImages: true,
});
```

Pass `compatibleFetch` only to `createOpenAICompatible`. Keep `dynamicFetch` for Anthropic, OpenAI Responses, and raw invocation.

In moved `runtime.test.ts`, change the type import from `../src` to `..`, change the runtime import to `./runtime`, and change `./test-support` to `../../_test/test-support`. Do not change its existing raw resolver test.

Create `packages/plugins/github-copilot/src/runtime/tool-images.test.ts` exactly:

```ts
import type { ModelCatalog } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { GitHubCopilotCredential } from "../github-api";

import { credentialPort, withFetchMock } from "../../_test/test-support";
import { createGitHubCopilotRuntime } from "./runtime";

const toolImagePrompt = [
  {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "inspect", input: {} }],
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "call_1",
        toolName: "inspect",
        output: {
          type: "content" as const,
          value: [
            { type: "text" as const, text: "before" },
            {
              type: "file" as const,
              mediaType: "image/png",
              data: { type: "data" as const, data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "low" },
                aioProxy: { toolImage: true },
              },
            },
          ],
        },
      },
    ],
  },
] as const;

test("compatible delegate emits CPA tool image content", async () => {
  const credentials = credentialPort(validCredential());
  const runtime = await createGitHubCopilotRuntime({
    credentials: credentials.port,
    options: { deploymentType: "github.com" },
    catalog: catalog(),
  });
  let captured: Request | undefined;

  await withFetchMock(
    async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        id: "chatcmpl-test",
        created: 1,
        model: "gpt-chat",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
    () => runtime.provider.languageModel("gpt-chat").doGenerate({ prompt: toolImagePrompt }),
  );

  expect((await captured?.json()) as unknown).toMatchObject({
    messages: [
      expect.objectContaining({ role: "assistant" }),
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
        ],
      },
    ],
  });
});

function catalog(): ModelCatalog {
  return {
    language: [{ id: "gpt-chat", metadata: { protocol: "openai-compatible" } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function validCredential(): GitHubCopilotCredential {
  return {
    githubToken: "github-token",
    copilotToken: "copilot-token",
    expiresAt: Date.now() + 60_000,
    baseURL: "https://api.githubcopilot.com",
  };
}
```

The existing raw resolver test remains in moved `runtime.test.ts`; it proves marked or unmarked raw bodies do not enter this delegate.

- [x] **Step 7: Wrap only the Kimi compatible delegate**

Move the Kimi runtime source and test to the paths in the Files list. Create `packages/plugins/kimi-code/src/runtime/index.ts`:

```ts
export * from "./runtime";
```

In moved `runtime.ts`, change `./headers` to `../headers`, change `./oauth` to `../oauth`, import `createOpenAIStreamFetch` from `@aio-proxy/plugin-sdk/openai-stream`, and add this immediately after `dynamicFetch`:

```ts
const compatibleFetch = createOpenAIStreamFetch("openai-compatible", dynamicFetch, {
  rewriteToolImages: true,
});
```

Pass `compatibleFetch` only to `createOpenAICompatible`. Keep raw invocation exactly:

```ts
invoke: async (request) => dynamicFetch(rewriteRawRequest(request, protocol)),
```

In moved `runtime.test.ts`, change `./oauth` to `../oauth`; its `./runtime` import remains a valid sibling import. Create `packages/plugins/kimi-code/src/runtime/tool-images.test.ts` exactly:

```ts
import type { CredentialPort, ModelCatalog } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { KimiCredential } from "../oauth";

import { createKimiRuntime } from "./runtime";

const toolImagePrompt = [
  {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "inspect", input: {} }],
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "call_1",
        toolName: "inspect",
        output: {
          type: "content" as const,
          value: [
            { type: "text" as const, text: "before" },
            {
              type: "file" as const,
              mediaType: "image/png",
              data: { type: "data" as const, data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "low" },
                aioProxy: { toolImage: true },
              },
            },
          ],
        },
      },
    ],
  },
] as const;

test("compatible delegate emits CPA tool image content", async () => {
  let captured: Request | undefined;
  const runtime = await createKimiRuntime(context(validCredential(), catalog()), {
    fetch: async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        id: "chatcmpl-test",
        created: 1,
        model: "openai-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });

  await runtime.provider.languageModel("openai-model").doGenerate({ prompt: toolImagePrompt });

  expect((await captured?.json()) as unknown).toMatchObject({
    messages: [
      expect.objectContaining({ role: "assistant" }),
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
        ],
      },
    ],
  });
});

function validCredential(): KimiCredential {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: 4_000_000_000_000,
    deviceId: "device-1",
  };
}

function credentialPort(initial: KimiCredential): CredentialPort<KimiCredential> {
  return {
    read: async () => ({ value: initial, revision: 1 }),
    refresh: async () => {
      throw new Error("tool image test must not refresh credentials");
    },
  };
}

function catalog(): ModelCatalog {
  return {
    language: [{ id: "openai-model", metadata: { protocol: "openai-compatible" } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function context(credential: KimiCredential, modelCatalog: ModelCatalog) {
  return { credentials: credentialPort(credential), options: {}, catalog: modelCatalog };
}
```

- [x] **Step 8: Run all compatible-path tests**

Run:

```bash
rtk bun test packages/plugin-sdk/src/openai-stream
rtk bun test packages/core/src/provider/api/api-openai-stream.test.ts packages/core/src/provider/ai-sdk/ai-sdk-tool-images.test.ts packages/core/src/provider/api-bridge/api-bridge-tool-images.test.ts
rtk bun test packages/plugins/github-copilot/src/runtime packages/plugins/kimi-code/src/runtime
rtk bun run check
```

Expected: all commands exit 0. The marked model body is rewritten in all four model-path seams; unmarked JSON and raw requests are unchanged.

- [x] **Step 9: Commit Task 8**

```bash
rtk git add -A -- packages/plugin-sdk/src/openai-stream packages/core/src/provider/openai-stream-fetch.ts packages/core/src/provider/api/api-openai-stream.test.ts packages/core/src/provider/ai-sdk/ai-sdk-tool-images.test.ts packages/core/src/provider/api-bridge/api-bridge-tool-images.test.ts packages/plugins/github-copilot/src/runtime packages/plugins/github-copilot/src/runtime.ts packages/plugins/github-copilot/_test/runtime.test.ts packages/plugins/kimi-code/src/runtime packages/plugins/kimi-code/src/runtime.ts packages/plugins/kimi-code/src/runtime.test.ts
rtk git commit -m "feat(provider): encode compatible tool images" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 9: Resolve Candidate Targets and Fall Back Before Image Loss

**Files:**

- Modify: `packages/core/src/provider/ai-sdk/ai-sdk.ts`
- Modify: `packages/core/src/provider/ai-sdk/ai-sdk.test.ts`
- Create: `packages/core/src/provider/api-bridge/api-bridge-target-protocol.test.ts`
- Modify: `packages/core/src/protocol/errors.ts`
- Modify: `packages/core/src/protocol/errors.test.ts`
- Modify: `packages/server/src/runtime.ts`
- Modify: `packages/server/src/provider-runtime/materialize.ts`
- Create: `packages/server/src/provider-runtime/materialize-target-protocol.test.ts`
- Modify: `packages/server/src/plugin-runtime/catalog.ts`
- Modify: `packages/server/src/plugin-runtime/capabilities.ts`
- Modify: `packages/server/src/plugin-runtime/capabilities.test.ts`
- Modify: `packages/server/src/routes/pipeline/attempt.ts`
- Modify: `packages/server/src/routes/pipeline/attempt.test.ts`
- Modify: `packages/server/_test/pipeline-helpers/providers.ts`

**Interfaces:**

- Consumes: Task 2 `imageTargetProtocolForPackage()`, `assertImageInputSupported()`, and `ImageInputUnsupportedError`.
- Produces: optional per-candidate `targetProtocol(modelId)` metadata and candidate-local 501 fallback before a lossy SDK call.

- [ ] **Step 1: Add protocol-shaped typed-error tests**

In `packages/core/src/protocol/errors.test.ts`, import `ImageInputUnsupportedError` and the four error mappers. Add:

```ts
test("maps image compatibility errors into every inbound protocol shape", async () => {
  const error = new ImageInputUnsupportedError("gemini-tool-url", "messages.2.content.0.output.value.1");
  const cases = [
    [openAICompletionsErrors, 501, "unsupported_feature"],
    [openAIResponsesErrors, 501, "unsupported_feature"],
    [anthropicMessagesErrors, 501, "invalid_request_error"],
    [geminiGenerateContentErrors, 501, "UNIMPLEMENTED"],
  ] as const;

  for (const [mapper, status, marker] of cases) {
    const response = mapper.modelUnsupported?.(error);
    expect(response?.status).toBe(status);
    const body = await response?.text();
    expect(body).toContain(marker);
    expect(body).not.toContain("https://");
    expect(body).not.toContain("file_");
  }
});
```

- [ ] **Step 2: Add server fallback regressions**

Add the optional field below to both inline parameter types: `modelProvider(options: { ... })` and `instrumentModel(model: { ... })`. Then preserve it in `instrumentModel()` as a constant resolver:

```ts
readonly targetProtocol?: ProviderProtocol;

...(model.targetProtocol === undefined
  ? {}
  : { targetProtocol: () => model.targetProtocol }),
```

Add these tests to `attempt.test.ts`:

```ts
test("skips a Gemini candidate for a remote tool-result image and invokes the next target", async () => {
  const gemini = modelProvider({
    id: "gemini",
    targetProtocol: ProviderProtocol.Gemini,
    invoke: () => textStream("must not run"),
  });
  const anthropic = modelProvider({
    id: "anthropic",
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream("fallback response"),
  });
  const route = defineProviderRouteSource([gemini, anthropic]);
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: "https://example.test/image.png" }],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording();

  expect(response.status).toBe(200);
  expect(gemini.calls.model).toHaveLength(0);
  expect(anthropic.calls.model).toHaveLength(1);
  expect(anthropic.calls.model[0]?.messages[1]).toMatchObject({
    role: "tool",
    content: [
      {
        output: {
          type: "content",
          value: [
            {
              type: "file",
              mediaType: "image",
              data: { type: "url", url: new URL("https://example.test/image.png") },
            },
          ],
        },
      },
    ],
  });
  expect(route.recording.attempts.map(({ errorCode, outcome, providerId }) => ({ errorCode, outcome, providerId }))).toEqual([
    { errorCode: "unsupported_feature", outcome: "failure", providerId: "gemini" },
    { errorCode: undefined, outcome: "success", providerId: "anthropic" },
  ]);
});

test("falls back after an OpenAI-compatible endpoint rejects the CPA extension", async () => {
  const compatible = modelProvider({
    id: "compatible",
    targetProtocol: ProviderProtocol.OpenAICompatible,
    invoke: () => errorStream(new Error("compatible endpoint rejected tool image content")),
  });
  const responses = modelProvider({
    id: "responses",
    targetProtocol: ProviderProtocol.OpenAIResponse,
    invoke: () => textStream("fallback response"),
  });
  const route = defineProviderRouteSource([compatible, responses]);
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording();

  expect(response.status).toBe(200);
  expect(compatible.calls.model).toHaveLength(1);
  expect(responses.calls.model).toHaveLength(1);
  expect(route.recording.attempts.map(({ outcome, providerId }) => ({ outcome, providerId }))).toEqual([
    { outcome: "failure", providerId: "compatible" },
    { outcome: "success", providerId: "responses" },
  ]);
});
```

Add `errorStream` to the existing pipeline-helper import. The first test is the required real route-level canonical image and typed-preflight fallback case; the second proves there is no same-Provider semantic retry.

- [ ] **Step 3: Run the new tests and observe missing target/preflight behavior**

Run:

```bash
rtk bun test packages/core/src/protocol/errors.test.ts packages/server/src/routes/pipeline/attempt.test.ts
```

Expected: FAIL because error mappers have no image mapping and the Gemini model is invoked.

- [ ] **Step 4: Publish target protocol on configured AI SDK instances**

In `ai-sdk.ts`, add `ProviderProtocol` to the existing `@aio-proxy/types` type import and import `imageTargetProtocolForPackage` from `../../image-input`. Extend `AiSdkProviderInstance`:

```ts
readonly targetProtocol?: ProviderProtocol;
```

At the start of `createAiSdkProvider()` compute:

```ts
const targetProtocol = imageTargetProtocolForPackage(config.packageName);
```

Return it with:

```ts
...(targetProtocol === undefined ? {} : { targetProtocol }),
```

In `ai-sdk.test.ts`, import the `ProviderProtocol` value and add this table test for all four known packages plus an unknown package:

```ts
test.each([
  ["@ai-sdk/openai", ProviderProtocol.OpenAIResponse],
  ["@ai-sdk/openai-compatible", ProviderProtocol.OpenAICompatible],
  ["@ai-sdk/anthropic", ProviderProtocol.Anthropic],
  ["@ai-sdk/google", ProviderProtocol.Gemini],
  ["@vendor/unknown", undefined],
] as const)("publishes the image target for %s", (packageName, targetProtocol) => {
  const provider = createAiSdkProvider({
    kind: "ai-sdk",
    id: packageName,
    packageName,
  });

  expect(provider.targetProtocol).toBe(targetProtocol);
});
```

Create `packages/core/src/provider/api-bridge/api-bridge-target-protocol.test.ts` exactly, rather than growing the existing 263-line general bridge test:

```ts
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import { bridgeApiProviderToAiSdk } from "../../index";

test.each([
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
] as const)("publishes %s as the API bridge image target", (protocol) => {
  const bridge = bridgeApiProviderToAiSdk({
    kind: ProviderKind.Api,
    id: `provider-${protocol}`,
    protocol,
    baseURL: "https://api.example.test/v1",
    models: ["model"],
  });

  expect(bridge?.targetProtocol).toBe(protocol);
});
```

This is correct because `bridgeMapping()` maps each API protocol to the matching installed package.

- [ ] **Step 5: Add the runtime target resolver and materialize it**

Extend `ModelTransport` in `packages/server/src/runtime.ts`:

```ts
readonly targetProtocol?: (modelId: string) => ProviderProtocol | undefined;
```

In both API-bridge and AI SDK branches of `materializeRuntimeProvider()`, copy the constant instance metadata as a resolver:

```ts
...(provider.targetProtocol === undefined
  ? {}
  : { targetProtocol: () => provider.targetProtocol }),
```

Use `options.apiBridge.targetProtocol` in the API branch. Extend `isModelTransport()` with:

```ts
(!("targetProtocol" in value) ||
  value.targetProtocol === undefined ||
  typeof value.targetProtocol === "function")
```

Create `packages/server/src/provider-runtime/materialize-target-protocol.test.ts` exactly. It covers both branches without growing the existing 287-line general test:

```ts
import type { AiSdkProviderInstance, ApiProviderInstance } from "@aio-proxy/core";

import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import { materializeRuntimeProvider } from "./materialize";

test("materializes configured target protocol resolvers", () => {
  const invoke = () => new ReadableStream();
  const aiSdk = {
    enabled: true,
    id: "ai-sdk",
    invoke,
    kind: ProviderKind.AiSdk,
    targetProtocol: ProviderProtocol.Anthropic,
  } satisfies AiSdkProviderInstance;
  const aiSdkRuntime = materializeRuntimeProvider(aiSdk);

  expect(aiSdkRuntime.model?.targetProtocol?.("any-model")).toBe(ProviderProtocol.Anthropic);

  const api = {
    baseURL: "https://api.example.test",
    enabled: true,
    id: "api",
    kind: ProviderKind.Api,
    passthrough: async () => new Response(),
    protocol: ProviderProtocol.Gemini,
  } satisfies ApiProviderInstance;
  const bridge = {
    enabled: true,
    id: "api:bridge",
    invoke,
    kind: ProviderKind.AiSdk,
    targetProtocol: ProviderProtocol.Gemini,
  } satisfies AiSdkProviderInstance;
  const apiRuntime = materializeRuntimeProvider(api, { apiBridge: bridge });

  expect(apiRuntime.model?.targetProtocol?.("any-model")).toBe(ProviderProtocol.Gemini);
});
```

- [ ] **Step 6: Retain OAuth catalog protocol metadata**

Extend `RuntimeModelMetadata`:

```ts
export type RuntimeModelMetadata = {
  readonly displayName?: string;
  readonly protocol?: ProviderProtocol;
};
```

In `packages/server/src/plugin-runtime/catalog.ts`, import the `ProviderProtocol` value and replace `modelMetadata()` with:

```ts
export function modelMetadata(catalog: ModelCatalog): Readonly<Record<string, RuntimeModelMetadata>> {
  return Object.fromEntries(
    catalog.language.map((descriptor) => {
      const protocol = metadataProtocol(descriptor.metadata);
      return [
        descriptor.id,
        {
          ...(descriptor.displayName === undefined ? {} : { displayName: descriptor.displayName }),
          ...(protocol === undefined ? {} : { protocol }),
        },
      ];
    }),
  );
}

function metadataProtocol(metadata: unknown): ProviderProtocol | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const protocol = Reflect.get(metadata, "protocol");
  switch (protocol) {
    case ProviderProtocol.OpenAICompatible:
    case ProviderProtocol.OpenAIResponse:
    case ProviderProtocol.Anthropic:
    case ProviderProtocol.Gemini:
      return protocol;
    default:
      return undefined;
  }
}
```

Import `RuntimeModelMetadata` from `../runtime`. In `createRuntimeProvider()`, compute metadata once:

```ts
const metadata = modelMetadata(catalog);
```

Use it for `modelMetadata: metadata` and add to the model capability:

```ts
targetProtocol: (modelId) => metadata[modelId]?.protocol,
```

In `capabilities.test.ts`, change the fixture model metadata to `{ region: "us", protocol: "anthropic" }` and assert:

```ts
expect(result.provider?.modelMetadata?.[modelId]).toEqual({
  displayName: "Model",
  protocol: ProviderProtocol.Anthropic,
});
expect(result.provider?.model?.targetProtocol?.(modelId)).toBe(ProviderProtocol.Anthropic);
```

The raw resolver must still receive the full original catalog metadata object including `region`.

- [ ] **Step 7: Map the typed error through all protocol adapters**

Import `ImageInputUnsupportedError` in `packages/core/src/protocol/errors.ts`. Add these exact `modelUnsupported` functions:

```ts
// openAICompletionsErrors
modelUnsupported: (error) =>
  error instanceof ImageInputUnsupportedError
    ? openAIInvalid(501, "unsupported_feature", "Image input cannot be represented by this provider")
    : undefined,

// openAIResponsesErrors: retain the existing Responses unsupported branch too
modelUnsupported(error) {
  if (error instanceof OpenAIResponsesUnsupportedFeatureError) return openAIUnsupported(error.feature);
  return error instanceof ImageInputUnsupportedError ? openAIUnsupported("image_input") : undefined;
},

// anthropicMessagesErrors
modelUnsupported: (error) =>
  error instanceof ImageInputUnsupportedError
    ? anthropicError(501, "invalid_request_error", "Image input cannot be represented by this provider")
    : undefined,

// geminiGenerateContentErrors
modelUnsupported: (error) =>
  error instanceof ImageInputUnsupportedError
    ? geminiError(501, "UNIMPLEMENTED", "Image input cannot be represented by this provider")
    : undefined,
```

Do not add the compatibility error to `provider()` mapping; it is a local candidate capability decision.

- [ ] **Step 8: Run preflight immediately before model invocation**

Import `assertImageInputSupported` in `attempt.ts`. After confirming `invocation` is defined and before Provider-tool support and `ensureAvailable()`, insert:

```ts
try {
  assertImageInputSupported(invocation.messages, model.targetProtocol?.(candidate.modelId));
} catch (error) {
  const unsupported = adapter.errors.modelUnsupported?.(error);
  if (unsupported === undefined) throw error;
  const base = attemptBase(provider, candidate.modelId, startedAt);
  if (hasNext) {
    session.attempt(failedAttempt(base, unsupported.status, "unsupported_feature"));
    lastFailure = unsupported;
    continue;
  }
  session.finish(finalFailure(base, unsupported.status, "unsupported_feature"));
  return unsupported;
}
```

Do not materialize `adapter.modelInvocation()` per candidate; keep the existing single cached invocation. Do not call `ensureAvailable()` or `model.invoke()` for a rejected candidate.

- [ ] **Step 9: Run target, protocol, and pipeline tests**

Run:

```bash
rtk bun test packages/core/src/provider/ai-sdk/ai-sdk.test.ts packages/core/src/provider/api-bridge/api-bridge-target-protocol.test.ts packages/core/src/protocol/errors.test.ts
rtk bun test packages/server/src/provider-runtime/materialize.test.ts packages/server/src/provider-runtime/materialize-target-protocol.test.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/routes/pipeline/attempt.test.ts
rtk bun run --filter @aio-proxy/server test:unit
rtk bun run check
```

Expected: all commands exit 0. The Gemini candidate records a local unsupported attempt without invocation, the Anthropic fallback receives the URL `FilePart`, and a CPA rejection reaches the next Provider.

- [ ] **Step 10: Commit Task 9**

```bash
rtk git add packages/core/src/provider/ai-sdk/ai-sdk.ts packages/core/src/provider/ai-sdk/ai-sdk.test.ts packages/core/src/provider/api-bridge/api-bridge-target-protocol.test.ts packages/core/src/protocol/errors.ts packages/core/src/protocol/errors.test.ts packages/server/src/runtime.ts packages/server/src/provider-runtime/materialize.ts packages/server/src/provider-runtime/materialize-target-protocol.test.ts packages/server/src/plugin-runtime/catalog.ts packages/server/src/plugin-runtime/capabilities.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/routes/pipeline/attempt.ts packages/server/src/routes/pipeline/attempt.test.ts packages/server/_test/pipeline-helpers/providers.ts
rtk git commit -m "feat(server): preflight candidate image compatibility" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Final Verification

- [ ] **Step 1: Format only the files changed by these tasks**

Run the formatter only over the explicit implementation scopes in this plan:

```bash
rtk bunx oxfmt --write \
  packages/plugins/openai-chatgpt/src/plugin.ts \
  packages/plugins/openai-chatgpt/oauth.smoke.ts \
  packages/core/src/image-input \
  packages/core/src/error.ts \
  packages/core/src/index.ts \
  packages/core/src/ingress/openai-responses/input-items.ts \
  packages/core/src/transform/openai-responses \
  packages/core/src/egress/openai-responses/state.ts \
  packages/core/src/transform/openai-completions \
  packages/core/src/ingress/anthropic-messages \
  packages/core/src/transform/anthropic-messages \
  packages/core/src/protocol/anthropic-messages \
  packages/core/src/ingress/gemini-generate-content \
  packages/core/src/transform/gemini-generate-content \
  packages/core/_test/fixtures/gemini-generate-content \
  packages/plugin-sdk/src/openai-stream \
  packages/core/src/provider/openai-stream-fetch.ts \
  packages/core/src/provider/api/api-openai-stream.test.ts \
  packages/core/src/provider/ai-sdk/ai-sdk.ts \
  packages/core/src/provider/ai-sdk/ai-sdk.test.ts \
  packages/core/src/provider/ai-sdk/ai-sdk-tool-images.test.ts \
  packages/core/src/provider/api-bridge/api-bridge-tool-images.test.ts \
  packages/core/src/provider/api-bridge/api-bridge-target-protocol.test.ts \
  packages/core/src/protocol/errors.ts \
  packages/core/src/protocol/errors.test.ts \
  packages/plugins/github-copilot/src/runtime \
  packages/plugins/kimi-code/src/runtime \
  packages/server/src/runtime.ts \
  packages/server/src/provider-runtime/materialize.ts \
  packages/server/src/provider-runtime/materialize-target-protocol.test.ts \
  packages/server/src/plugin-runtime/catalog.ts \
  packages/server/src/plugin-runtime/capabilities.ts \
  packages/server/src/plugin-runtime/capabilities.test.ts \
  packages/server/src/routes/pipeline/attempt.ts \
  packages/server/src/routes/pipeline/attempt.test.ts \
  packages/server/_test/pipeline-helpers/providers.ts
```

Expected: formatter exits 0. Review `rtk git diff --stat` afterward; only paths listed in the command may change.

- [ ] **Step 2: Run all focused image tests together**

```bash
rtk bun test packages/core/src/image-input packages/core/src/ingress/openai-responses packages/core/src/transform/openai-responses packages/core/src/transform/openai-completions packages/core/src/ingress/anthropic-messages packages/core/src/transform/anthropic-messages packages/core/src/protocol/anthropic-messages packages/core/src/ingress/gemini-generate-content packages/core/src/transform/gemini-generate-content
rtk bun test packages/plugin-sdk/src/openai-stream packages/core/src/provider/api/api-openai-stream.test.ts packages/core/src/provider/ai-sdk/ai-sdk.test.ts packages/core/src/provider/ai-sdk/ai-sdk-tool-images.test.ts packages/core/src/provider/api-bridge/api-bridge.test.ts packages/core/src/provider/api-bridge/api-bridge-tool-images.test.ts packages/core/src/provider/api-bridge/api-bridge-target-protocol.test.ts packages/core/src/protocol/errors.test.ts
rtk bun test packages/plugins/github-copilot/src/runtime packages/plugins/kimi-code/src/runtime
rtk bun test packages/server/src/provider-runtime/materialize.test.ts packages/server/src/provider-runtime/materialize-target-protocol.test.ts packages/server/src/plugin-runtime/capabilities.test.ts packages/server/src/routes/pipeline/attempt.test.ts
rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:artifact
```

Expected: every command exits 0.

- [ ] **Step 3: Run the repository gate**

```bash
rtk bun run preflight
```

Expected: oxlint, oxfmt check, and every workspace unit test pass.

- [ ] **Step 4: Audit the acceptance criteria against artifacts**

Run:

```bash
rtk git status --short
rtk git log --oneline -10
```

Expected:

- no uncommitted implementation files remain;
- the nine task commits are present;
- the Responses regression proves no local image 501 during canonical conversion;
- the three native wire tests and CPA wrapper test prove visual wire encodings;
- the server tests prove candidate preflight and ordinary upstream fallback;
- the ChatGPT artifact test proves same-protocol Responses raw capability remains available.

If formatting changed tracked implementation files after Task 9, commit only those formatting changes:

```bash
rtk git add -u -- \
  packages/plugins/openai-chatgpt/src/plugin.ts \
  packages/plugins/openai-chatgpt/oauth.smoke.ts \
  packages/core/src/image-input \
  packages/core/src/error.ts \
  packages/core/src/index.ts \
  packages/core/src/ingress/openai-responses/input-items.ts \
  packages/core/src/transform/openai-responses \
  packages/core/src/egress/openai-responses/state.ts \
  packages/core/src/transform/openai-completions \
  packages/core/src/ingress/anthropic-messages \
  packages/core/src/transform/anthropic-messages \
  packages/core/src/protocol/anthropic-messages \
  packages/core/src/ingress/gemini-generate-content \
  packages/core/src/transform/gemini-generate-content \
  packages/core/_test/fixtures/gemini-generate-content \
  packages/plugin-sdk/src/openai-stream \
  packages/core/src/provider/openai-stream-fetch.ts \
  packages/core/src/provider/api/api-openai-stream.test.ts \
  packages/core/src/provider/ai-sdk/ai-sdk.ts \
  packages/core/src/provider/ai-sdk/ai-sdk.test.ts \
  packages/core/src/provider/ai-sdk/ai-sdk-tool-images.test.ts \
  packages/core/src/provider/api-bridge/api-bridge-tool-images.test.ts \
  packages/core/src/provider/api-bridge/api-bridge-target-protocol.test.ts \
  packages/core/src/protocol/errors.ts \
  packages/core/src/protocol/errors.test.ts \
  packages/plugins/github-copilot/src/runtime \
  packages/plugins/kimi-code/src/runtime \
  packages/server/src/runtime.ts \
  packages/server/src/provider-runtime/materialize.ts \
  packages/server/src/provider-runtime/materialize-target-protocol.test.ts \
  packages/server/src/plugin-runtime/catalog.ts \
  packages/server/src/plugin-runtime/capabilities.ts \
  packages/server/src/plugin-runtime/capabilities.test.ts \
  packages/server/src/routes/pipeline/attempt.ts \
  packages/server/src/routes/pipeline/attempt.test.ts \
  packages/server/_test/pipeline-helpers/providers.ts
rtk git commit -m "style: format cross-protocol image support" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Do not create an empty formatting commit.
