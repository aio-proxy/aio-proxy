# Usage Pricing Double-Count Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop double-counting inclusive cache/reasoning tokens in `estimatedCostUsd` by price-aware billable normalization keyed on usage source (passthrough protocol vs AI SDK), while keeping stored token fields raw.

**Architecture:** Move pricing into `packages/core/src/usage-pricing/` with a private `toBillableUsage(usage, price, accounting)` used only inside `calculateEstimatedCost`. Server `usage-capture` passes `{ source: "passthrough", protocol }` or `{ source: "ai-sdk" }` into pricing and is colocated under `packages/server/src/usage-capture/`.

**Tech Stack:** Bun, TypeScript, `@aio-proxy/types` `ProviderProtocol`, existing models.dev OpenRouter USD/1M catalog.

## Global Constraints

- Stored `UsageRow` token fields stay **raw** (upstream / AI SDK totals); only cost uses billable buckets.
- Normalization key is **usage source**, not inbound adapter protocol alone; stream path always uses `source: "ai-sdk"`.
- Price-aware peel: subtract a subset from its parent **only when** that subset’s catalog unit price exists; otherwise leave tokens in the parent.
- `toBillableUsage` is **private**; `priceUsage` must not pre-normalize.
- Forward-only costs; no historical backfill; no invented CCH `0.1×` / new-api cache ratios.
- Colocate tests per `AGENTS.md` (`foo/index.ts`, `foo/foo.ts`, `foo/foo.test.ts`); migrate legacy `_test` coverage when touching the module.
- Prefer `rtk` prefix for shell commands in this environment.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `packages/core/src/usage-pricing/usage-pricing.ts` | Types, private peel helpers, private `toBillableUsage`, public `calculateEstimatedCost` |
| `packages/core/src/usage-pricing/index.ts` | Public re-exports only |
| `packages/core/src/usage-pricing/usage-pricing.test.ts` | Unit tests for billable math |
| `packages/core/src/usage-pricing.ts` | **Delete** after move |
| `packages/core/_test/usage-pricing.test.ts` | **Delete** after move |
| `packages/core/src/index.ts` | Re-export `UsageAccounting` from `./usage-pricing` |
| `packages/core/src/models-dev-catalog.ts` | Import `OpenRouterModelPrice` from `./usage-pricing` (directory) — path unchanged |
| `packages/server/src/usage-capture/usage-capture.ts` | Capture streams/passthrough; pass `UsageAccounting` into pricing |
| `packages/server/src/usage-capture/index.ts` | Public re-exports |
| `packages/server/src/usage-capture/usage-capture.test.ts` | Migrated + extended capture tests |
| `packages/server/src/usage-capture.ts` | **Delete** after move |
| `packages/server/_test/request-recorder.test.ts` | Remove `describe("usage capture")` block; keep recorder-only tests |

---

### Task 1: Core price-aware `calculateEstimatedCost`

**Files:**
- Create: `packages/core/src/usage-pricing/usage-pricing.ts`
- Create: `packages/core/src/usage-pricing/index.ts`
- Create: `packages/core/src/usage-pricing/usage-pricing.test.ts`
- Modify: `packages/core/src/index.ts` (export `UsageAccounting`)
- Delete: `packages/core/src/usage-pricing.ts`
- Delete: `packages/core/_test/usage-pricing.test.ts`

**Interfaces:**
- Consumes: `ProviderProtocol` from `@aio-proxy/types`
- Produces:
  - `export type UsageAccounting = { readonly source: "passthrough"; readonly protocol: ProviderProtocol } | { readonly source: "ai-sdk" }`
  - `export function calculateEstimatedCost(usage: UsagePricingInput, price: OpenRouterModelPrice, accounting: UsageAccounting): UsageCostResult | undefined`
  - Existing `OpenRouterModelPrice`, `UsagePricingInput`, `UsageCostResult` unchanged in shape

- [ ] **Step 1: Write the failing colocated unit tests**

Create `packages/core/src/usage-pricing/usage-pricing.test.ts`:

```ts
import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import { calculateEstimatedCost } from "./usage-pricing";

const openaiPassthrough = {
  source: "passthrough",
  protocol: ProviderProtocol.OpenAICompatible,
} as const;

const anthropicPassthrough = {
  source: "passthrough",
  protocol: ProviderProtocol.Anthropic,
} as const;

const geminiPassthrough = {
  source: "passthrough",
  protocol: ProviderProtocol.Gemini,
} as const;

const aiSdk = { source: "ai-sdk" } as const;

describe("calculateEstimatedCost billable normalization", () => {
  test("passthrough OpenAI peels priced cacheRead (CCH 2006/1920/300)", () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 2006, outputTokens: 300, cacheReadTokens: 1920 },
        { id: "openai/gpt-test", input: 2, output: 10, cacheRead: 0.5 },
        openaiPassthrough,
      ),
    ).toEqual({
      // (86*2 + 1920*0.5 + 300*10) / 1e6
      estimatedCostUsd: 0.004132,
      priceModelId: "openai/gpt-test",
    });
  });

  test("passthrough OpenAI keeps cache tokens in input when cacheRead price is missing", () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 2006, outputTokens: 300, cacheReadTokens: 1920 },
        { id: "openai/gpt-test", input: 2, output: 10 },
        openaiPassthrough,
      ),
    ).toEqual({
      // (2006*2 + 300*10) / 1e6
      estimatedCostUsd: 0.007012,
      priceModelId: "openai/gpt-test",
    });
  });

  test("passthrough Anthropic does not peel cache from input", () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
        { id: "anthropic/claude", input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 },
        anthropicPassthrough,
      ),
    ).toEqual({
      // (100*2 + 20*10 + 50*0.5 + 10*3) / 1e6
      estimatedCostUsd: 0.000455,
      priceModelId: "anthropic/claude",
    });
  });

  test("passthrough Gemini folds unpriced thoughts into output", () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 400,
          reasoningTokens: 50,
        },
        { id: "google/gemini", input: 1, output: 2, cacheRead: 0.25 },
        geminiPassthrough,
      ),
    ).toEqual({
      // input 600, cache 400, output 150
      // (600*1 + 400*0.25 + 150*2) / 1e6
      estimatedCostUsd: 0.001,
      priceModelId: "google/gemini",
    });
  });

  test("passthrough Gemini charges priced thoughts on the reasoning line", () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 400,
          reasoningTokens: 50,
        },
        { id: "google/gemini", input: 1, output: 2, cacheRead: 0.25, reasoning: 3 },
        geminiPassthrough,
      ),
    ).toEqual({
      // input 600, cache 400, output 100, reasoning 50
      // (600*1 + 400*0.25 + 100*2 + 50*3) / 1e6
      estimatedCostUsd: 0.00105,
      priceModelId: "google/gemini",
    });
  });

  test("peels priced reasoning from inclusive OpenAI output", () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 10, outputTokens: 1000, reasoningTokens: 400 },
        { id: "perplexity/sonar-deep-research", input: 1, output: 8, reasoning: 3 },
        openaiPassthrough,
      ),
    ).toEqual({
      // (10*1 + 600*8 + 400*3) / 1e6
      estimatedCostUsd: 0.00601,
      priceModelId: "perplexity/sonar-deep-research",
    });
  });

  test("keeps reasoning inside output when reasoning price is missing", () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 10, outputTokens: 1000, reasoningTokens: 400 },
        { id: "model", input: 1, output: 8 },
        openaiPassthrough,
      ),
    ).toEqual({
      // (10*1 + 1000*8) / 1e6
      estimatedCostUsd: 0.00801,
      priceModelId: "model",
    });
  });

  test("ai-sdk peels priced cache read and write from inclusive input", () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 4,
          outputTokens: 6,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 3,
        },
        { id: "priced/model", input: 2, output: 10, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
        aiSdk,
      ),
    ).toEqual({
      // input 1, output 3, cacheRead 2, cacheWrite 1, reasoning 3
      // (1*2 + 3*10 + 2*3 + 1*4 + 3*5) / 1e6
      estimatedCostUsd: 0.000057,
      priceModelId: "priced/model",
    });
  });

  test("ai-sdk leaves unpriced cacheWrite inside input", () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 4,
          outputTokens: 6,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
        { id: "priced/model", input: 2, output: 10, cacheRead: 3 },
        aiSdk,
      ),
    ).toEqual({
      // peel only cacheRead → input 2; write stays in input
      // (2*2 + 6*10 + 2*3) / 1e6
      estimatedCostUsd: 0.00007,
      priceModelId: "priced/model",
    });
  });

  test("ai-sdk does not add unpriced reasoning on top of inclusive output", () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 10, outputTokens: 150, reasoningTokens: 50 },
        { id: "google/gemini", input: 1, output: 2 },
        aiSdk,
      ),
    ).toEqual({
      // (10*1 + 150*2) / 1e6
      estimatedCostUsd: 0.00031,
      priceModelId: "google/gemini",
    });
  });

  test("clamps peeled parents at zero when subsets exceed totals", () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 10, outputTokens: 5, cacheReadTokens: 40, reasoningTokens: 9 },
        { id: "model", input: 1, output: 2, cacheRead: 0.5, reasoning: 3 },
        openaiPassthrough,
      ),
    ).toEqual({
      // input 0, cache 40, output 0, reasoning 9
      // (0 + 40*0.5 + 0 + 9*3) / 1e6
      estimatedCostUsd: 0.000047,
      priceModelId: "model",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
rtk bun test packages/core/src/usage-pricing/usage-pricing.test.ts
```

Expected: FAIL (module path / `accounting` argument missing / wrong costs).

- [ ] **Step 3: Implement the colocated module**

Create `packages/core/src/usage-pricing/usage-pricing.ts`:

```ts
import { ProviderProtocol } from "@aio-proxy/types";

export type OpenRouterModelPrice = {
  readonly id: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
};

export type UsagePricingInput = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
};

export type UsageCostResult = {
  readonly priceModelId: string;
  readonly estimatedCostUsd: number;
};

export type UsageAccounting =
  | { readonly source: "passthrough"; readonly protocol: ProviderProtocol }
  | { readonly source: "ai-sdk" };

export function calculateEstimatedCost(
  usage: UsagePricingInput,
  price: OpenRouterModelPrice,
  accounting: UsageAccounting,
): UsageCostResult | undefined {
  const billable = toBillableUsage(usage, price, accounting);
  let cost = 0;
  let priced = false;

  const add = (tokens: number | undefined, unitPrice: number | undefined) => {
    if (tokens === undefined || unitPrice === undefined) {
      return;
    }
    cost += (tokens * unitPrice) / 1_000_000;
    priced = true;
  };

  add(billable.inputTokens, price.input);
  add(billable.outputTokens, price.output);
  add(billable.cacheReadTokens, price.cacheRead);
  add(billable.cacheWriteTokens, price.cacheWrite);
  add(billable.reasoningTokens, price.reasoning);

  return priced ? { estimatedCostUsd: cost, priceModelId: price.id } : undefined;
}

function toBillableUsage(
  usage: UsagePricingInput,
  price: OpenRouterModelPrice,
  accounting: UsageAccounting,
): UsagePricingInput {
  if (accounting.source === "ai-sdk") {
    const afterCache = peelSubsets(usage.inputTokens, [
      { count: usage.cacheReadTokens, unitPrice: price.cacheRead },
      { count: usage.cacheWriteTokens, unitPrice: price.cacheWrite },
    ]);
    const afterReasoning = peelSubsets(usage.outputTokens, [
      { count: usage.reasoningTokens, unitPrice: price.reasoning },
    ]);
    return {
      ...(afterCache.parent === undefined ? {} : { inputTokens: afterCache.parent }),
      ...(afterReasoning.parent === undefined ? {} : { outputTokens: afterReasoning.parent }),
      ...(pricedSubset(usage.cacheReadTokens, price.cacheRead) === undefined
        ? {}
        : { cacheReadTokens: usage.cacheReadTokens }),
      ...(pricedSubset(usage.cacheWriteTokens, price.cacheWrite) === undefined
        ? {}
        : { cacheWriteTokens: usage.cacheWriteTokens }),
      ...(pricedSubset(usage.reasoningTokens, price.reasoning) === undefined
        ? {}
        : { reasoningTokens: usage.reasoningTokens }),
    };
  }

  switch (accounting.protocol) {
    case ProviderProtocol.Anthropic:
      return usage;
    case ProviderProtocol.OpenAICompatible:
    case ProviderProtocol.OpenAIResponse: {
      const afterCache = peelSubsets(usage.inputTokens, [
        { count: usage.cacheReadTokens, unitPrice: price.cacheRead },
        { count: usage.cacheWriteTokens, unitPrice: price.cacheWrite },
      ]);
      const afterReasoning = peelSubsets(usage.outputTokens, [
        { count: usage.reasoningTokens, unitPrice: price.reasoning },
      ]);
      return {
        ...(afterCache.parent === undefined ? {} : { inputTokens: afterCache.parent }),
        ...(afterReasoning.parent === undefined ? {} : { outputTokens: afterReasoning.parent }),
        ...(pricedSubset(usage.cacheReadTokens, price.cacheRead) === undefined
          ? {}
          : { cacheReadTokens: usage.cacheReadTokens }),
        ...(pricedSubset(usage.cacheWriteTokens, price.cacheWrite) === undefined
          ? {}
          : { cacheWriteTokens: usage.cacheWriteTokens }),
        ...(pricedSubset(usage.reasoningTokens, price.reasoning) === undefined
          ? {}
          : { reasoningTokens: usage.reasoningTokens }),
      };
    }
    case ProviderProtocol.Gemini: {
      const afterCache = peelSubsets(usage.inputTokens, [
        { count: usage.cacheReadTokens, unitPrice: price.cacheRead },
      ]);
      const thoughts = usage.reasoningTokens;
      const reasoningPriced = pricedSubset(thoughts, price.reasoning) !== undefined;
      const outputTokens =
        usage.outputTokens === undefined && thoughts === undefined
          ? undefined
          : reasoningPriced
            ? (usage.outputTokens ?? 0)
            : (usage.outputTokens ?? 0) + (thoughts ?? 0);
      return {
        ...(afterCache.parent === undefined ? {} : { inputTokens: afterCache.parent }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(pricedSubset(usage.cacheReadTokens, price.cacheRead) === undefined
          ? {}
          : { cacheReadTokens: usage.cacheReadTokens }),
        ...(reasoningPriced ? { reasoningTokens: thoughts } : {}),
      };
    }
    default: {
      const _exhaustive: never = accounting.protocol;
      return _exhaustive;
    }
  }
}

function peelSubsets(
  parent: number | undefined,
  subsets: readonly { readonly count: number | undefined; readonly unitPrice: number | undefined }[],
): { readonly parent: number | undefined } {
  if (parent === undefined) {
    return { parent: undefined };
  }
  let next = parent;
  for (const subset of subsets) {
    if (pricedSubset(subset.count, subset.unitPrice) === undefined || subset.count === undefined) {
      continue;
    }
    next = Math.max(0, next - subset.count);
  }
  return { parent: next };
}

function pricedSubset(count: number | undefined, unitPrice: number | undefined): number | undefined {
  return count !== undefined && unitPrice !== undefined ? count : undefined;
}
```

Create `packages/core/src/usage-pricing/index.ts`:

```ts
export {
  calculateEstimatedCost,
  type OpenRouterModelPrice,
  type UsageAccounting,
  type UsageCostResult,
  type UsagePricingInput,
} from "./usage-pricing";
```

Update `packages/core/src/index.ts` export block to:

```ts
export {
  calculateEstimatedCost,
  type OpenRouterModelPrice,
  type UsageAccounting,
  type UsageCostResult,
  type UsagePricingInput,
} from "./usage-pricing";
```

Delete `packages/core/src/usage-pricing.ts` and `packages/core/_test/usage-pricing.test.ts`.

- [ ] **Step 4: Run unit tests to verify they pass**

Run:

```bash
rtk bun test packages/core/src/usage-pricing/usage-pricing.test.ts
```

Expected: PASS (all cases green).

Also run:

```bash
rtk bun run --filter @aio-proxy/core test:unit
```

Expected: PASS (`models-dev-catalog` still resolves `./usage-pricing`).

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/usage-pricing packages/core/src/index.ts
rtk git add -u packages/core/src/usage-pricing.ts packages/core/_test/usage-pricing.test.ts
rtk git commit -m "$(cat <<'EOF'
fix(core): price-aware billable usage normalization

Peel inclusive cache/reasoning subsets only when models.dev publishes
matching unit prices, keyed by passthrough protocol or AI SDK source.
EOF
)"
```

---

### Task 2: Wire server capture + migrate tests

**Files:**
- Create: `packages/server/src/usage-capture/usage-capture.ts`
- Create: `packages/server/src/usage-capture/index.ts`
- Create: `packages/server/src/usage-capture/usage-capture.test.ts`
- Delete: `packages/server/src/usage-capture.ts`
- Modify: `packages/server/_test/request-recorder.test.ts` (remove `describe("usage capture")` and helpers only used by it: `textStream`, `finishPart`, `drain` if unused)

**Interfaces:**
- Consumes: `calculateEstimatedCost(usage, price, accounting)`, `UsageAccounting` from `@aio-proxy/core`
- Produces: same `createUsageCapture` / `UsageCapture` / `UsageCompletion` public API; `stream` billing uses `{ source: "ai-sdk" }`; `passthrough` uses `{ source: "passthrough", protocol }`

- [ ] **Step 1: Move implementation and thread accounting into `priceUsage`**

Create `packages/server/src/usage-capture/usage-capture.ts` by moving the current `packages/server/src/usage-capture.ts` contents, then change imports/pricing as follows:

```ts
import {
  calculateEstimatedCost,
  type OpenRouterPriceCatalog,
  type TextStreamPart,
  type ToolSet,
  type UsageAccounting,
} from "@aio-proxy/core";
```

Keep passthrough-usage imports relative: `from "../passthrough-usage"`.

Replace `priceUsage` + `pricingInput` with:

```ts
async function priceUsage(
  usage: UsageRow | undefined,
  priceCatalogTask: () => Promise<OpenRouterPriceCatalog | undefined>,
  accounting: UsageAccounting,
): Promise<UsageRow | undefined> {
  if (usage === undefined) {
    return undefined;
  }
  try {
    const price = (await priceCatalogTask())?.find(usage.modelId);
    const cost =
      price === undefined
        ? undefined
        : calculateEstimatedCost(
            {
              ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
              ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
              ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
              ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
              ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
            },
            price,
            accounting,
          );
    return cost === undefined ? usage : { ...usage, ...cost };
  } catch {
    return usage;
  }
}
```

Call sites inside the same file:

- Stream success path: `priceUsage(finishUsage, options.priceCatalogTask, { source: "ai-sdk" })`
- Passthrough success path: `priceUsage(..., { source: "passthrough", protocol })` where `protocol` is the passthrough option already in scope

Create `packages/server/src/usage-capture/index.ts`:

```ts
export {
  createUsageCapture,
  type Captured,
  type PassthroughUsageOptions,
  type StreamUsageOptions,
  type UsageCapture,
  type UsageCompletion,
} from "./usage-capture";
```

Delete `packages/server/src/usage-capture.ts`. Existing imports of `../usage-capture` / `./usage-capture` resolve via the directory index.

- [ ] **Step 2: Move and extend capture tests**

Create `packages/server/src/usage-capture/usage-capture.test.ts` containing the former `describe("usage capture")` block from `packages/server/_test/request-recorder.test.ts`, with local helpers `textStream`, `finishPart`, `drain`, `settle`.

Update the existing priced stream expectation to the AI SDK billable math:

```ts
estimatedCostUsd: 0.000057,
```

(raw tokens on the usage object stay `inputTokens: 4`, `outputTokens: 6`, etc.)

Add these tests in the same file:

```ts
test("ai-sdk Gemini-shaped usage does not double-count unpriced thoughts", async () => {
  const catalog: OpenRouterPriceCatalog = {
    find: () => ({ id: "google/gemini", input: 1, output: 2 }),
  };
  const finish: TextStreamPart<ToolSet> = {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: 10 },
      inputTokens: 10,
      outputTokenDetails: { reasoningTokens: 50, textTokens: 100 },
      outputTokens: 150,
      totalTokens: 160,
    },
  };
  const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
    providerId: "provider",
    modelId: "gemini",
    stream: textStream([finish]),
  });
  await drain(captured.value);
  await expect(captured.completion).resolves.toEqual({
    outcome: "success",
    usage: expect.objectContaining({
      inputTokens: 10,
      outputTokens: 150,
      reasoningTokens: 50,
      // (10*1 + 150*2) / 1e6 — reasoning not added again
      estimatedCostUsd: 0.00031,
      priceModelId: "google/gemini",
    }),
  });
});

test("ai-sdk Anthropic-shaped usage peels priced cache read and write once", async () => {
  const catalog: OpenRouterPriceCatalog = {
    find: () => ({ id: "anthropic/claude", input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 }),
  };
  const finish: TextStreamPart<ToolSet> = {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 10, noCacheTokens: 50 },
      inputTokens: 100,
      outputTokenDetails: { reasoningTokens: undefined, textTokens: 20 },
      outputTokens: 20,
      totalTokens: 120,
    },
  };
  const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
    providerId: "provider",
    modelId: "claude",
    stream: textStream([finish]),
  });
  await drain(captured.value);
  await expect(captured.completion).resolves.toEqual({
    outcome: "success",
    usage: expect.objectContaining({
      inputTokens: 100,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      // billable input 50: (50*2 + 20*10 + 40*0.5 + 10*3) / 1e6
      estimatedCostUsd: 0.00035,
      priceModelId: "anthropic/claude",
    }),
  });
});

test("passthrough OpenAI SSE keeps raw input and peels priced cache", async () => {
  const body = [
    'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"content":"Hi"}}]}',
    "",
    'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2006,"completion_tokens":300,"total_tokens":2306,"prompt_tokens_details":{"cached_tokens":1920}}}',
    "",
    "data: [DONE]",
  ].join("\n");
  const catalog: OpenRouterPriceCatalog = {
    find: () => ({ id: "openai/gpt-test", input: 2, output: 10, cacheRead: 0.5 }),
  };
  const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).passthrough({
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    protocol: ProviderProtocol.OpenAICompatible,
    providerId: "provider",
    modelId: "gpt",
  });
  expect(await captured.value.text()).toBe(body);
  await expect(captured.completion).resolves.toEqual({
    outcome: "success",
    statusCode: 200,
    usage: expect.objectContaining({
      inputTokens: 2006,
      cacheReadTokens: 1920,
      outputTokens: 300,
      estimatedCostUsd: 0.004132,
      priceModelId: "openai/gpt-test",
    }),
  });
});

test("passthrough OpenAI without cacheRead price does not undercharge", async () => {
  const body = JSON.stringify({
    usage: {
      prompt_tokens: 2006,
      completion_tokens: 300,
      total_tokens: 2306,
      prompt_tokens_details: { cached_tokens: 1920 },
    },
  });
  const catalog: OpenRouterPriceCatalog = {
    find: () => ({ id: "openai/gpt-test", input: 2, output: 10 }),
  };
  const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).passthrough({
    response: new Response(body, { headers: { "content-type": "application/json" } }),
    protocol: ProviderProtocol.OpenAICompatible,
    providerId: "provider",
    modelId: "gpt",
  });
  await captured.value.text();
  await expect(captured.completion).resolves.toEqual({
    outcome: "success",
    statusCode: 200,
    usage: expect.objectContaining({
      inputTokens: 2006,
      cacheReadTokens: 1920,
      estimatedCostUsd: 0.007012,
    }),
  });
});
```

From `packages/server/_test/request-recorder.test.ts`, delete the entire `describe("usage capture", …)` block and remove now-unused imports/helpers (`createUsageCapture`, `OpenRouterPriceCatalog`, `TextStreamPart`, `ToolSet`, `textStream`, `finishPart`, `drain` if nothing else needs them). Keep `settle` if recorder tests still use it.

- [ ] **Step 3: Run server unit tests**

Run:

```bash
rtk bun test packages/server/src/usage-capture/usage-capture.test.ts
```

Expected: PASS.

Also run:

```bash
rtk bun run --filter @aio-proxy/server test:unit
```

Expected: PASS (imports to `usage-capture` resolve; request-recorder tests still pass).

- [ ] **Step 4: Commit**

```bash
rtk git add packages/server/src/usage-capture packages/server/_test/request-recorder.test.ts
rtk git add -u packages/server/src/usage-capture.ts
rtk git commit -m "$(cat <<'EOF'
fix(server): bill usage by source-aware accounting

Pass passthrough protocol vs AI SDK source into core pricing, colocate
usage-capture tests, and cover cache/reasoning peel regressions.
EOF
)"
```

---

## Self-Review

**Spec coverage**
- Price-aware cache peel → Task 1 tests + Task 2 undercharge passthrough test
- Price-aware reasoning peel → Task 1 OpenAI/Gemini/AI SDK cases; Task 2 Gemini unpriced thoughts
- Usage source not inbound protocol → Task 2 stream always `{ source: "ai-sdk" }`
- Private `toBillableUsage` / single owner → Task 1 API; Task 2 `priceUsage` only calls `calculateEstimatedCost`
- Colocate core + server tests → both tasks
- No dual-inbound stream test → omitted per spec
- Raw storage → Task 2 expectations keep raw `inputTokens` / `reasoningTokens`

**Placeholders:** none; commands and expected costs are concrete.

**Type consistency:** `UsageAccounting`, `calculateEstimatedCost(..., accounting)`, `priceUsage(..., accounting)` match across tasks.
