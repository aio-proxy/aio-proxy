# Model Usage Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an observational usage ledger that records successful model-call token usage and estimated OpenRouter-based cost.

**Architecture:** Keep public usage shapes in `@aio-proxy/types`, pricing and persistence in small server/core helpers, and route accounting behind one shared recorder. Raw passthrough parsing is best-effort and never changes the returned upstream response.

**Tech Stack:** TypeScript, Bun 1.3.14, Zod 4, Hono, Drizzle SQLite, TanStack Router, TanStack Query, shadcn UI components already in the repo.

## Global Constraints

- Use `rtk` before shell commands in this repo.
- Do not add new runtime dependencies.
- Do not add accounts, balances, budgets, invoices, or request blocking.
- Record only successful completed requests that expose usage.
- Treat `models.dev` OpenRouter costs as USD per 1 million tokens.
- Cache the fetched OpenRouter price catalog for 6 hours, then refresh on the next request that needs pricing.
- Price matching is exact full id first, then unique bare id after `/`.
- Accounting failures must not alter client responses.
- Dashboard copy must come from `packages/i18n/messages/*.json`.
- Do not edit `packages/dashboard/src/route-tree.gen.ts` by hand.

---

## File Structure

- Modify `packages/types/src/usage.ts`, `packages/types/src/dashboard.ts`, `packages/types/src/trace.ts`: extend shared usage and dashboard response schemas.
- Create `packages/core/src/usage-pricing.ts` and `packages/core/_test/usage-pricing.test.ts`: OpenRouter price loading, model matching, and cost calculation.
- Create `packages/core/src/db/schema/usage.ts`; modify `packages/core/src/db/schema/index.ts`, migrations, and manifest: usage ledger table.
- Create `packages/server/src/usage-ledger.ts`, `packages/server/src/usage-recorder.ts`, and `packages/server/src/passthrough-usage.ts`: persistence and recording helpers.
- Modify `packages/server/src/server-state.ts`, `packages/server/src/server.ts`, `packages/server/src/dashboard-routes/config.ts`, and the four route files in `packages/server/src/routes/`: wire ledger, recorder, and usage API.
- Create or modify server tests under `packages/server/_test/`: route recording, passthrough usage parsing, and dashboard API.
- Create dashboard usage module under `packages/dashboard/src/modules/usage/`; add `packages/dashboard/src/routes/usage.tsx`; modify side menu and i18n messages.

---

### Task 1: Shared Usage And Pricing Types

**Files:**
- Modify: `packages/types/src/usage.ts`
- Modify: `packages/types/src/dashboard.ts`
- Modify: `packages/types/src/trace.ts`
- Create: `packages/core/src/usage-pricing.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/types/_test/schemas.test.ts`
- Test: `packages/core/_test/usage-pricing.test.ts`

**Interfaces:**
- Produces: `UsageRow` with optional cache, reasoning, `priceModelId`, and `estimatedCostUsd`.
- Produces: `calculateEstimatedCost(usage: UsagePricingInput, price: OpenRouterModelPrice): UsageCostResult`.
- Produces: `createOpenRouterPriceCatalog(fetchJson?: FetchOpenRouterPrices): Promise<OpenRouterPriceCatalog>`.

- [ ] **Step 1: Write failing schema tests**

Add a usage roundtrip test in `packages/types/_test/schemas.test.ts`:

```ts
  test("roundtrips usage rows with price and optional token dimensions", () => {
    const event = {
      type: "end",
      traceId: "trace-1",
      timestamp: "2026-07-09T00:00:01.000Z",
      usage: {
        providerId: "openrouter",
        modelId: "gpt-5.5",
        inputTokens: 1000,
        outputTokens: 2000,
        totalTokens: 3000,
        cacheReadTokens: 500,
        cacheWriteTokens: 250,
        reasoningTokens: 100,
        priceModelId: "openai/gpt-5.5",
        estimatedCostUsd: 0.0123,
      },
    };

    expect(TraceEventSchema.parse(event)).toEqual(event);
  });
```

Run:

```bash
rtk bun test packages/types/_test/schemas.test.ts
```

Expected: FAIL because the new usage fields are rejected.

- [ ] **Step 2: Extend usage schemas**

Update `packages/types/src/usage.ts`:

```ts
import { z } from "zod";
import { IdSchema } from "./common";

const TokenCountSchema = z.number().int().min(0);

export const UsageRowSchema = z.object({
  providerId: IdSchema,
  modelId: IdSchema,
  inputTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema.optional(),
  totalTokens: TokenCountSchema.optional(),
  cacheReadTokens: TokenCountSchema.optional(),
  cacheWriteTokens: TokenCountSchema.optional(),
  reasoningTokens: TokenCountSchema.optional(),
  priceModelId: IdSchema.optional(),
  estimatedCostUsd: z.number().min(0).optional(),
});

export type UsageRowInput = z.input<typeof UsageRowSchema>;
export type UsageRow = z.output<typeof UsageRowSchema>;
```

Keep `dashboard.ts` and `trace.ts` importing `UsageRowSchema`; no event-name changes are needed.

- [ ] **Step 3: Write failing pricing tests**

Create `packages/core/_test/usage-pricing.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { calculateEstimatedCost, createOpenRouterPriceCatalog } from "../src/usage-pricing";

const api = {
  openrouter: {
    models: {
      "openai/gpt-5.5": {
        id: "openai/gpt-5.5",
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.5,
          cache_write: 1,
          reasoning: 10,
        },
      },
    },
  },
};

describe("OpenRouter usage pricing", () => {
  test("matches full and bare model ids", async () => {
    const catalog = await createOpenRouterPriceCatalog(async () => api);

    expect(catalog.find("openai/gpt-5.5")?.id).toBe("openai/gpt-5.5");
    expect(catalog.find("gpt-5.5")?.id).toBe("openai/gpt-5.5");
  });

  test("calculates cost from known token dimensions", () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 100_000,
          cacheWriteTokens: 200_000,
          reasoningTokens: 300_000,
        },
        {
          id: "openai/gpt-5.5",
          input: 2,
          output: 10,
          cacheRead: 0.5,
          cacheWrite: 1,
          reasoning: 10,
        },
      ),
    ).toEqual({
      estimatedCostUsd: 10.25,
      priceModelId: "openai/gpt-5.5",
    });
  });
});
```

Run:

```bash
rtk bun test packages/core/_test/usage-pricing.test.ts
```

Expected: FAIL because `usage-pricing.ts` does not exist.

- [ ] **Step 4: Implement pricing helper**

Create `packages/core/src/usage-pricing.ts`:

```ts
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

export type OpenRouterPriceCatalog = {
  readonly find: (modelId: string) => OpenRouterModelPrice | undefined;
};

type FetchOpenRouterPrices = () => Promise<unknown>;

const defaultFetch: FetchOpenRouterPrices = async () => fetch("https://models.dev/api.json").then((response) => response.json());

export async function createOpenRouterPriceCatalog(fetchJson: FetchOpenRouterPrices = defaultFetch): Promise<OpenRouterPriceCatalog> {
  const prices = parsePrices(await fetchJson());
  const byId = new Map(prices.map((price) => [price.id, price]));
  const byBareId = new Map<string, OpenRouterModelPrice>();
  const duplicateBareIds = new Set<string>();

  for (const price of prices) {
    const bareId = price.id.split("/").at(-1) ?? price.id;
    if (byBareId.has(bareId)) {
      duplicateBareIds.add(bareId);
      byBareId.delete(bareId);
      continue;
    }
    if (!duplicateBareIds.has(bareId)) {
      byBareId.set(bareId, price);
    }
  }

  return {
    find(modelId) {
      return byId.get(modelId) ?? byBareId.get(modelId);
    },
  };
}

export function calculateEstimatedCost(usage: UsagePricingInput, price: OpenRouterModelPrice): UsageCostResult | undefined {
  let cost = 0;
  let priced = false;

  const add = (tokens: number | undefined, unitPrice: number | undefined) => {
    if (tokens === undefined || unitPrice === undefined) {
      return;
    }
    cost += (tokens * unitPrice) / 1_000_000;
    priced = true;
  };

  add(usage.inputTokens, price.input);
  add(usage.outputTokens, price.output);
  add(usage.cacheReadTokens, price.cacheRead);
  add(usage.cacheWriteTokens, price.cacheWrite);
  add(usage.reasoningTokens, price.reasoning);

  return priced ? { estimatedCostUsd: cost, priceModelId: price.id } : undefined;
}

function parsePrices(value: unknown): OpenRouterModelPrice[] {
  if (!isRecord(value) || !isRecord(value.openrouter) || !isRecord(value.openrouter.models)) {
    return [];
  }
  return Object.values(value.openrouter.models).flatMap((model) => {
    if (!isRecord(model) || typeof model.id !== "string" || !isRecord(model.cost)) {
      return [];
    }
    return [
      {
        id: model.id,
        ...(typeof model.cost.input === "number" ? { input: model.cost.input } : {}),
        ...(typeof model.cost.output === "number" ? { output: model.cost.output } : {}),
        ...(typeof model.cost.cache_read === "number" ? { cacheRead: model.cost.cache_read } : {}),
        ...(typeof model.cost.cache_write === "number" ? { cacheWrite: model.cost.cache_write } : {}),
        ...(typeof model.cost.reasoning === "number" ? { reasoning: model.cost.reasoning } : {}),
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

Export it from `packages/core/src/index.ts`:

```ts
export {
  calculateEstimatedCost,
  createOpenRouterPriceCatalog,
  type OpenRouterModelPrice,
  type OpenRouterPriceCatalog,
  type UsageCostResult,
  type UsagePricingInput,
} from "./usage-pricing";
```

- [ ] **Step 5: Verify task**

Run:

```bash
rtk bun test packages/types/_test/schemas.test.ts packages/core/_test/usage-pricing.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/types/src/usage.ts packages/types/src/dashboard.ts packages/types/src/trace.ts packages/types/_test/schemas.test.ts packages/core/src/usage-pricing.ts packages/core/src/index.ts packages/core/_test/usage-pricing.test.ts
git commit -m "feat: add usage pricing types" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Usage Ledger Storage

**Files:**
- Create: `packages/core/src/db/schema/usage.ts`
- Modify: `packages/core/src/db/schema/index.ts`
- Create: `packages/core/src/db/migrations/0001_usage.sql`
- Modify: `packages/core/src/db/migrations.manifest.ts`
- Create: `packages/server/src/usage-ledger.ts`
- Test: `packages/server/_test/usage-ledger.test.ts`

**Interfaces:**
- Produces: `UsageLedger.insert(row: UsageLedgerInsert): void`.
- Produces: `UsageLedger.list(limit: number): readonly UsageLedgerRow[]`.
- Produces: `UsageLedger.summary(limit: number): UsageSummary`.

- [ ] **Step 1: Write failing ledger tests**

Create `packages/server/_test/usage-ledger.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { openDb } from "@aio-proxy/core/db";
import { createUsageLedger } from "../src/usage-ledger";

let homes: string[] = [];

afterEach(() => {
  for (const home of homes) {
    rmSync(home, { force: true, recursive: true });
  }
  homes = [];
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-usage-"));
  homes.push(home);
  return home;
}

describe("usage ledger", () => {
  test("stores rows and computes summaries", () => {
    const db = openDb({ home: tempHome() });
    try {
      const ledger = createUsageLedger(db.db);
      ledger.insert({
        id: "usage-1",
        traceId: "trace-1",
        providerId: "openrouter",
        modelId: "gpt-5.5",
        priceModelId: "openai/gpt-5.5",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        reasoningTokens: 20,
        estimatedCostUsd: 0.001,
        createdAt: new Date(0),
      });

      expect(ledger.list(10)).toHaveLength(1);
      expect(ledger.summary(10)).toEqual({
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        reasoningTokens: 20,
        estimatedCostUsd: 0.001,
      });
    } finally {
      db.close();
    }
  });
});
```

Run:

```bash
rtk bun test packages/server/_test/usage-ledger.test.ts
```

Expected: FAIL because `usage-ledger.ts` and the table do not exist.

- [ ] **Step 2: Add schema and migration**

Create `packages/core/src/db/schema/usage.ts`:

```ts
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const usage = sqliteTable("usage", {
  id: text("id").primaryKey(),
  traceId: text("trace_id").notNull(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  priceModelId: text("price_model_id"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  estimatedCostUsd: real("estimated_cost_usd"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
```

Update `packages/core/src/db/schema/index.ts`:

```ts
export { auth } from "./auth";
export { usage } from "./usage";
```

Create `packages/core/src/db/migrations/0001_usage.sql`:

```sql
CREATE TABLE `usage` (
  `id` text PRIMARY KEY NOT NULL,
  `trace_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `model_id` text NOT NULL,
  `price_model_id` text,
  `input_tokens` integer,
  `output_tokens` integer,
  `total_tokens` integer,
  `cache_read_tokens` integer,
  `cache_write_tokens` integer,
  `reasoning_tokens` integer,
  `estimated_cost_usd` real,
  `created_at` integer NOT NULL
);
```

Regenerate the migration manifest:

```bash
rtk bun run build:migrations
```

Expected: `packages/core/src/db/migrations.manifest.ts` updates with version 1 and the SHA-256 for `0001_usage.sql`.

- [ ] **Step 3: Implement ledger helper**

Create `packages/server/src/usage-ledger.ts`:

```ts
import { desc } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { usage } from "@aio-proxy/core/db/schema/usage";

export type UsageLedgerInsert = {
  readonly id: string;
  readonly traceId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly priceModelId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly createdAt: Date;
};

export type UsageLedgerRow = UsageLedgerInsert;

export type UsageSummary = {
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
};

export type UsageLedger = {
  readonly insert: (row: UsageLedgerInsert) => void;
  readonly list: (limit: number) => readonly UsageLedgerRow[];
  readonly summary: (limit: number) => UsageSummary;
};

export function createUsageLedger(db: BunSQLiteDatabase): UsageLedger {
  return {
    insert(row) {
      db.insert(usage).values(row).run();
    },
    list(limit) {
      return db.select().from(usage).orderBy(desc(usage.createdAt)).limit(limit).all();
    },
    summary(limit) {
      const rows = db.select().from(usage).orderBy(desc(usage.createdAt)).limit(limit).all();
      return rows.reduce<UsageSummary>(
        (acc, row) => ({
          requestCount: acc.requestCount + 1,
          inputTokens: acc.inputTokens + (row.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (row.outputTokens ?? 0),
          totalTokens: acc.totalTokens + (row.totalTokens ?? 0),
          cacheReadTokens: acc.cacheReadTokens + (row.cacheReadTokens ?? 0),
          cacheWriteTokens: acc.cacheWriteTokens + (row.cacheWriteTokens ?? 0),
          reasoningTokens: acc.reasoningTokens + (row.reasoningTokens ?? 0),
          estimatedCostUsd: acc.estimatedCostUsd + (row.estimatedCostUsd ?? 0),
        }),
        emptySummary(),
      );
    },
  };
}

function emptySummary(): UsageSummary {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
  };
}
```

- [ ] **Step 4: Verify task**

Run:

```bash
rtk bun test packages/server/_test/usage-ledger.test.ts packages/core/_test/open-db-paths.test.ts packages/oauth/_test/store.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/core/src/db/schema/index.ts packages/core/src/db/schema/usage.ts packages/core/src/db/migrations/0001_usage.sql packages/core/src/db/migrations.manifest.ts packages/server/src/usage-ledger.ts packages/server/_test/usage-ledger.test.ts
git commit -m "feat: add usage ledger storage" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Shared Recorder And Passthrough Usage Extraction

**Files:**
- Create: `packages/server/src/usage-recorder.ts`
- Create: `packages/server/src/passthrough-usage.ts`
- Test: `packages/server/_test/usage-recorder.test.ts`
- Test: `packages/server/_test/passthrough-usage.test.ts`

**Interfaces:**
- Produces: `createUsageRecorder({ ledger, priceCatalogTask })`.
- Produces: `recordStreamUsage(options): ReadableStream<TextStreamPart<ToolSet>>`.
- Produces: `recordPassthroughUsage(options): Response`.
- Produces: `extractPassthroughUsage(protocol, bodyText): UsageRow | undefined`.

- [ ] **Step 1: Write failing recorder tests**

Create tests that prove:

- A stream with a `finish.totalUsage` writes one row after the stream is consumed.
- A stream without usage writes no row.
- A pricing failure still writes token usage without cost.

Use a fake ledger object with an in-memory `rows: UsageLedgerInsert[]` array and a fake price catalog promise. Run:

```bash
rtk bun test packages/server/_test/usage-recorder.test.ts
```

Expected: FAIL because the recorder does not exist.

- [ ] **Step 2: Implement recorder**

Create `packages/server/src/usage-recorder.ts` with these exports:

```ts
import { calculateEstimatedCost, type OpenRouterPriceCatalog } from "@aio-proxy/core";
import type { ProviderProtocol, UsageRow } from "@aio-proxy/types";
import type { TextStreamPart, ToolSet } from "ai";
import type { UsageLedger, UsageLedgerInsert } from "./usage-ledger";
import { extractPassthroughUsage } from "./passthrough-usage";

export type UsageRecorder = {
  readonly recordStreamUsage: (options: StreamUsageOptions) => ReadableStream<TextStreamPart<ToolSet>>;
  readonly recordPassthroughUsage: (options: PassthroughUsageOptions) => Response;
};

export type StreamUsageOptions = {
  readonly stream: ReadableStream<TextStreamPart<ToolSet>>;
  readonly providerId: string;
  readonly modelId: string;
  readonly traceId: string;
};

export type PassthroughUsageOptions = {
  readonly response: Response;
  readonly protocol: ProviderProtocol;
  readonly providerId: string;
  readonly modelId: string;
  readonly traceId: string;
};

export function createUsageRecorder(options: {
  readonly ledger: UsageLedger;
  readonly priceCatalogTask: () => Promise<OpenRouterPriceCatalog | undefined>;
}): UsageRecorder {
  const write = async (usage: UsageRow, traceId: string) => {
    const priced = await withPrice(usage, options.priceCatalogTask);
    options.ledger.insert({
      id: crypto.randomUUID(),
      traceId,
      providerId: usage.providerId,
      modelId: usage.modelId,
      ...(priced.priceModelId === undefined ? {} : { priceModelId: priced.priceModelId }),
      ...(priced.inputTokens === undefined ? {} : { inputTokens: priced.inputTokens }),
      ...(priced.outputTokens === undefined ? {} : { outputTokens: priced.outputTokens }),
      ...(priced.totalTokens === undefined ? {} : { totalTokens: priced.totalTokens }),
      ...(priced.cacheReadTokens === undefined ? {} : { cacheReadTokens: priced.cacheReadTokens }),
      ...(priced.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: priced.cacheWriteTokens }),
      ...(priced.reasoningTokens === undefined ? {} : { reasoningTokens: priced.reasoningTokens }),
      ...(priced.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: priced.estimatedCostUsd }),
      createdAt: new Date(),
    });
  };

  return {
    recordStreamUsage({ stream, providerId, modelId, traceId }) {
      let finishUsage: UsageRow | undefined;
      return new ReadableStream({
        async start(controller) {
          try {
            for await (const part of stream) {
              if (part.type === "finish") {
                finishUsage = normalizeAiSdkUsage(part, providerId, modelId);
              }
              controller.enqueue(part);
            }
            if (finishUsage !== undefined) {
              await write({ ...finishUsage, providerId, modelId }, traceId);
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
    },
    recordPassthroughUsage({ response, protocol, providerId, modelId, traceId }) {
      if (response.body === null || !response.ok) {
        return response;
      }
      const [returnedBody, tracedBody] = response.body.tee();
      void new Response(tracedBody)
        .text()
        .then((bodyText) => extractPassthroughUsage(protocol, bodyText))
        .then((usage) => (usage === undefined ? undefined : write({ ...usage, providerId, modelId }, traceId)))
        .catch(() => undefined);
      return new Response(returnedBody, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    },
  };
}
```

Add local helpers in the same file:

```ts
function normalizeAiSdkUsage(
  part: Extract<TextStreamPart<ToolSet>, { readonly type: "finish" }>,
  providerId: string,
  modelId: string,
): UsageRow | undefined {
  const usage = "usage" in part ? part.usage : part.totalUsage;
  if (usage === undefined) {
    return undefined;
  }
  return {
    providerId,
    modelId,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}

async function withPrice(
  usage: UsageRow,
  priceCatalogTask: () => Promise<OpenRouterPriceCatalog | undefined>,
): Promise<UsageRow> {
  const catalog = await priceCatalogTask();
  const price = catalog?.find(usage.modelId);
  if (price === undefined) {
    return usage;
  }
  const cost = calculateEstimatedCost(usage, price);
  return cost === undefined ? usage : { ...usage, ...cost };
}
```

- [ ] **Step 3: Write failing passthrough parser tests**

Create `packages/server/_test/passthrough-usage.test.ts` with cases for:

- OpenAI Chat JSON `usage.prompt_tokens`, `completion_tokens`, `total_tokens`.
- OpenAI Chat SSE chunk with a `usage` object.
- OpenAI Responses JSON `usage.input_tokens`, `output_tokens`, `total_tokens`.
- Anthropic JSON `usage.input_tokens`, `output_tokens`.
- Gemini JSON `usageMetadata.promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`.

Run:

```bash
rtk bun test packages/server/_test/passthrough-usage.test.ts
```

Expected: FAIL because parser does not exist.

- [ ] **Step 4: Implement passthrough parser**

Create `packages/server/src/passthrough-usage.ts`:

```ts
import { ProviderProtocol, type UsageRow } from "@aio-proxy/types";

export function extractPassthroughUsage(protocol: ProviderProtocol, bodyText: string): Omit<UsageRow, "providerId" | "modelId"> | undefined {
  const values = bodyText
    .split(/\n\n/u)
    .map((frame) => frame.split(/\n/u).find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? frame)
    .filter((value) => value !== "[DONE]" && value.trim() !== "");

  for (const value of values.reverse()) {
    const parsed = parseJson(value);
    const usage = parsed === undefined ? undefined : usageFromJson(protocol, parsed);
    if (usage !== undefined) {
      return usage;
    }
  }
  return undefined;
}
```

Implement `usageFromJson` with one branch per `ProviderProtocol`. Use tiny record guards and return `undefined` when the shape does not contain numeric usage fields.

- [ ] **Step 5: Verify task**

Run:

```bash
rtk bun test packages/server/_test/usage-recorder.test.ts packages/server/_test/passthrough-usage.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/server/src/usage-recorder.ts packages/server/src/passthrough-usage.ts packages/server/_test/usage-recorder.test.ts packages/server/_test/passthrough-usage.test.ts
git commit -m "feat: add usage recording helpers" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Wire Recording Into Server Routes

**Files:**
- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/routes/openai-completions.ts`
- Modify: `packages/server/src/routes/openai-responses.ts`
- Modify: `packages/server/src/routes/anthropic-messages.ts`
- Modify: `packages/server/src/routes/gemini-generate-content.ts`
- Test: `packages/server/_test/openai-completions.test.ts`
- Test: `packages/server/_test/openai-responses.test.ts`
- Test: `packages/server/_test/anthropic-messages.test.ts`
- Test: `packages/server/_test/gemini-generate-content.test.ts`

**Interfaces:**
- Extends `ServerState` with `usageRecorder`.
- Routes call `state.usageRecorder.recordStreamUsage` for AI SDK responses.
- Routes call `state.usageRecorder.recordPassthroughUsage` for raw passthrough responses.

- [ ] **Step 1: Add route tests**

Add one test to `packages/server/_test/openai-completions.test.ts`:

```ts
test("Given ai-sdk provider returns usage When completion finishes Then dashboard usage includes the row", async () => {
  const provider = {
    id: "mock-ai",
    kind: "ai-sdk",
    models: ["gpt-4o-mini"],
    alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
    invoke() {
      return textStream([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "Hello" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      ]);
    },
  } satisfies AiSdkProviderInstance;
  const app = createServer({
    config: { providers: {} },
    providerInstances: [provider],
  });

  const response = await app.request("/v1/chat/completions", {
    body: JSON.stringify({ ...chatRequest, stream: false }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await response.text();

  const usageResponse = await app.request("/dashboard/api/usage");
  expect(usageResponse.status).toBe(200);
  expect(await usageResponse.json()).toEqual({
    summary: expect.objectContaining({
      requestCount: 1,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    }),
    rows: [
      expect.objectContaining({
        providerId: "mock-ai",
        modelId: "gpt-4o-mini",
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      }),
    ],
  });
});
```

Run:

```bash
rtk bun test packages/server/_test/openai-completions.test.ts
```

Expected: FAIL because `/dashboard/api/usage` and recorder wiring do not exist.

- [ ] **Step 2: Add recorder to server state**

Open DB in `createServerState`, create the ledger and recorder, and close DB from `state.close()`. Add an optional `dbHome?: string` to `CreateServerOptions` and `ServerStateOptions` so tests can isolate SQLite files.

Use one 6-hour cached price task:

```ts
const PRICE_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
let priceCatalog:
  | {
      readonly expiresAt: number;
      readonly task: Promise<OpenRouterPriceCatalog | undefined>;
    }
  | undefined;
const priceCatalogTask = () => {
  const now = Date.now();
  if (priceCatalog === undefined || priceCatalog.expiresAt <= now) {
    priceCatalog = {
      expiresAt: now + PRICE_CATALOG_TTL_MS,
      task: createOpenRouterPriceCatalog().catch(() => undefined),
    };
  }
  return priceCatalog.task;
};
```

- [ ] **Step 3: Wire AI SDK routes**

In each route, wrap the stream immediately after `provider.invoke()`:

```ts
const stream = source.usageRecorder.recordStreamUsage({
  stream: aiSdkProvider.invoke({ ... }),
  providerId: provider.id,
  modelId: route.modelId,
  traceId: crypto.randomUUID(),
});
```

Pass that wrapped stream into the existing response writers. Do not change response bodies.

- [ ] **Step 4: Wire passthrough routes**

Replace direct raw passthrough returns with:

```ts
const response = await provider.passthrough(context.req.raw.clone());
const recorded = source.usageRecorder.recordPassthroughUsage({
  response,
  protocol: provider.protocol,
  providerId: provider.id,
  modelId: route.modelId,
  traceId: crypto.randomUUID(),
});
```

Use `recorded` for fallback status checks and returns.

- [ ] **Step 5: Verify task**

Run:

```bash
rtk bun test packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts packages/server/_test/anthropic-messages.test.ts packages/server/_test/gemini-generate-content.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/server/src/server-state.ts packages/server/src/server.ts packages/server/src/routes/openai-completions.ts packages/server/src/routes/openai-responses.ts packages/server/src/routes/anthropic-messages.ts packages/server/src/routes/gemini-generate-content.ts packages/server/_test/openai-completions.test.ts packages/server/_test/openai-responses.test.ts packages/server/_test/anthropic-messages.test.ts packages/server/_test/gemini-generate-content.test.ts
git commit -m "feat: record route usage" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Dashboard Usage API

**Files:**
- Modify: `packages/types/src/dashboard.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Test: `packages/types/_test/schemas.test.ts`
- Test: `packages/server/_test/usage-dashboard.test.ts`

**Interfaces:**
- Produces: `DashboardUsageResponseSchema`.
- Produces: `GET /dashboard/api/usage?limit=100`.

- [ ] **Step 1: Write failing API tests**

Create `packages/server/_test/usage-dashboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createServer } from "@aio-proxy/server";

describe("GET /dashboard/api/usage", () => {
  test("returns an empty usage summary", async () => {
    const app = createServer({ config: { providers: {} } });
    const response = await app.request("/dashboard/api/usage");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedCostUsd: 0,
      },
      rows: [],
    });
  });
});
```

Run:

```bash
rtk bun test packages/server/_test/usage-dashboard.test.ts
```

Expected: FAIL with 404.

- [ ] **Step 2: Add dashboard usage types**

In `packages/types/src/dashboard.ts`, add:

```ts
export const DashboardUsageSummarySchema = z.object({
  requestCount: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  reasoningTokens: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0),
});

export const DashboardUsageRowSchema = UsageRowSchema.extend({
  id: IdSchema,
  traceId: IdSchema,
  createdAt: z.string().datetime(),
});

export const DashboardUsageResponseSchema = z.object({
  summary: DashboardUsageSummarySchema,
  rows: z.array(DashboardUsageRowSchema),
});
```

Export the corresponding input and output types.

- [ ] **Step 3: Add API route**

In `packages/server/src/dashboard-routes/config.ts`, add:

```ts
    .get("/usage", (context) => {
      const rawLimit = context.req.query("limit");
      const limit = rawLimit === undefined ? 100 : Math.min(500, Math.max(1, Number.parseInt(rawLimit, 10) || 100));
      return context.json({
        summary: state.usageLedger.summary(limit),
        rows: state.usageLedger.list(limit).map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    })
```

Expose `usageLedger` on `ServerState`.

- [ ] **Step 4: Verify task**

Run:

```bash
rtk bun test packages/types/_test/schemas.test.ts packages/server/_test/usage-dashboard.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/types/src/dashboard.ts packages/types/_test/schemas.test.ts packages/server/src/dashboard-routes/config.ts packages/server/src/server-state.ts packages/server/_test/usage-dashboard.test.ts
git commit -m "feat: expose dashboard usage api" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Dashboard Usage Page

**Files:**
- Create: `packages/dashboard/src/modules/usage/services/usage-service.ts`
- Create: `packages/dashboard/src/modules/usage/hooks/use-usage-query.ts`
- Create: `packages/dashboard/src/modules/usage/templates/usage-page.tsx`
- Create: `packages/dashboard/src/routes/usage.tsx`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Produces: `usageQueryOptions()`.
- Produces: `/dashboard/usage` route.

- [ ] **Step 1: Add i18n keys**

Add English keys:

```json
"dashboard_usage_title": "Usage",
"dashboard_usage_total_cost": "Estimated cost",
"dashboard_usage_requests": "Requests",
"dashboard_usage_tokens": "Tokens",
"dashboard_usage_recent": "Recent usage",
"dashboard_usage_provider": "Provider",
"dashboard_usage_model": "Model",
"dashboard_usage_cost": "Cost",
"dashboard_usage_created": "Time",
"dashboard_usage_empty": "No usage recorded yet.",
"dashboard.menus.usage": "Usage"
```

Add Simplified Chinese keys with matching meanings. Keep existing keys unchanged.

- [ ] **Step 2: Add service and hook**

Create `packages/dashboard/src/modules/usage/services/usage-service.ts`:

```ts
import { queryOptions } from "@tanstack/react-query";
import { createDashboardClient } from "@/index";

const dashboardClient = createDashboardClient("");

export const usageQueryOptions = () =>
  queryOptions({
    queryKey: ["usage"],
    queryFn: async () => {
      const response = await dashboardClient.dashboard.api.usage.$get();
      return response.json();
    },
  });
```

Create `packages/dashboard/src/modules/usage/hooks/use-usage-query.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { usageQueryOptions } from "../services/usage-service";

export const useUsageQuery = () => useQuery(usageQueryOptions());
```

- [ ] **Step 3: Add page template**

Create `packages/dashboard/src/modules/usage/templates/usage-page.tsx` with one exported `UsagePage` component. Use existing `PageContainer`, `Card`, `Badge`, and `Table` components. Render loading text from `m.common_loading()`, an empty state when `rows.length === 0`, four summary cards, and a recent rows table.

Format cost with:

```ts
const usd = new Intl.NumberFormat(undefined, {
  currency: "USD",
  maximumFractionDigits: 6,
  style: "currency",
});
```

- [ ] **Step 4: Add route and menu item**

Create `packages/dashboard/src/routes/usage.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { UsagePage } from "@/modules/usage/templates/usage-page";

export const Route = createFileRoute("/usage")({ component: UsagePage });
```

In `side-menu.tsx`, add `ReceiptText` from `lucide-react` and a Usage menu item under Overview:

```ts
{
  id: "usage",
  label: m["dashboard.menus.usage"](),
  icon: ReceiptText,
  to: "/usage",
  isActive: (pathname) => pathname.startsWith("/usage"),
}
```

- [ ] **Step 5: Verify dashboard**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: PASS and route tree regenerated by the build tooling if needed.

Commit:

```bash
git add packages/dashboard/src/modules/usage packages/dashboard/src/routes/usage.tsx packages/dashboard/src/components/side-menu/side-menu.tsx packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/dashboard/src/route-tree.gen.ts
git commit -m "feat: add usage dashboard page" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 7: Full Verification And Manual QA

**Files:**
- Verify all changed files from Tasks 1 through 6.

- [ ] **Step 1: Run unit tests**

Run:

```bash
rtk bun run test:unit
```

Expected: PASS.

- [ ] **Step 2: Run static checks**

Run:

```bash
rtk bun run check
```

Expected: PASS.

- [ ] **Step 3: Run builds**

Run:

```bash
rtk bun run build
```

Expected: PASS.

- [ ] **Step 4: Manual QA through HTTP API**

Start the server with a mock or test provider that returns usage, then send:

```bash
curl -sS http://127.0.0.1:22078/health
curl -sS http://127.0.0.1:22078/dashboard/api/usage
```

Expected:

- `/health` returns `{ "status": "ok", ... }`.
- `/dashboard/api/usage` returns a summary and at least one row after the mock usage request completes.

- [ ] **Step 5: Manual QA through dashboard**

Open `/dashboard/usage` in a browser. Confirm:

- The Usage menu item is visible.
- Empty state renders before any usage exists.
- Summary cards and recent rows render after a usage row exists.
- Browser console has no uncaught errors.

- [ ] **Step 6: Final commit**

If Task 7 required fixes, commit them:

```bash
git add .
git commit -m "fix: verify usage billing flow" -m "Co-authored-by: Codex <noreply@openai.com>"
```

If no files changed during verification, do not create an empty commit.
