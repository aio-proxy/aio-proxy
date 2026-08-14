# API Provider 多协议端点实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API provider 可声明多个协议端点（`endpoints` 字段），inbound 协议命中任一端点即 raw 透传；端点 baseURL 采用 "ai-sdk 入参" 语义；anthropic 端点支持 `auth: 'bearer'`。

**Architecture:** 规范文档见 `docs/superpowers/specs/2026-08-12-api-provider-multi-protocol-endpoints-design.md`（务必先读）。核心：types 新增 `provider-endpoints` 模块（schema + union 级校验 refine + 纯函数归一化 `apiProviderEndpoints`，无 zod transform）；core 的 `createApiProvider` 产出 per-endpoint transports、`bridgeApiProviderToAiSdk` 读主端点；server 的 `materializeRuntimeProvider` 按端点集解析 raw、probe 只构造标准 inbound 路径。任务顺序刻意安排为"先加 helper 与运行时消费、最后翻转 schema 可选性"，保证每个任务提交后全仓类型检查与测试都是绿的。

**Tech Stack:** Bun + zod v4 + Turborepo monorepo；测试用 `bun:test`。

## Global Constraints

- 每个任务结束运行该包测试；整单收尾运行 `bun run preflight`（oxlint + oxfmt + 全部单测）。
- 新模块用同名目录 colocated 测试：`foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts`；已有平铺测试文件（如 `materialize.test.ts`）直接扩展，不要移动。
- 不新增依赖；通用工具优先 `es-toolkit`（narrow import，如 `es-toolkit/predicate`）。
- 注释只解释约束与原因，不复述代码。
- 域语言：Provider ID、Provider weight；不要写 "provider name/key"、"order/rank"。
- 旧写法（顶层 `protocol`+`baseURL`）行为**冻结**：透传只用 origin + inbound 路径（丢 baseURL path）、桥接用完整 baseURL。任何任务不得改变仅旧写法 provider 的行为。
- `endpoints` 条目 baseURL = "传给对应 `@ai-sdk/*` 包的入参"（已实证：`@ai-sdk/openai` / `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic` 默认含 `/v1`，`@ai-sdk/google` 含 `/v1beta`）。raw 透传剥版本前缀拼操作路径；桥接原样传包。
- mutation schema（`ApiProviderMutationBodySchema` 等）**不加** `endpoints`；dashboard 不改（PR 描述交接，见 Task 8）。
- 仓库根 `README.md` 是 `npm/aio-proxy/README.md` 的符号链接，文档编辑落在后者。

---

### Task 1: types `provider-endpoints` 模块（枚举迁移 + schema + 归一化 + 校验）

**Files:**
- Create: `packages/types/src/provider-endpoints/index.ts`
- Create: `packages/types/src/provider-endpoints/provider-endpoints.ts`
- Create: `packages/types/src/provider-endpoints/provider-endpoints.test.ts`
- Modify: `packages/types/src/provider.ts`（删除本地 `ProviderProtocol`/`ProviderProtocolSchema` 定义，改为 import + 具名 re-export）

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - `enum ProviderProtocol`（值不变，从 `provider.ts` 迁来）与 `ProviderProtocolSchema`
  - `const ProviderEndpointAuthSchema = z.enum(['bearer', 'x-api-key'])`；`type ProviderEndpointAuth = 'bearer' | 'x-api-key'`
  - `const ApiEndpointEntrySchema`（`{ protocol, baseURL, auth? }`）、`const ApiEndpointsInputSchema`（数组 `.min(1)` 或共享对象 `{ baseURL, protocol: [] }`）
  - `type ApiEndpointsInput = z.output<typeof ApiEndpointsInputSchema>`
  - `type NormalizedApiEndpoint = { readonly protocol: ProviderProtocol; readonly baseURL: string; readonly auth?: ProviderEndpointAuth; readonly mode: 'origin' | 'sdk' }`
  - `type ApiEndpointsSource = { readonly protocol?: ProviderProtocol | undefined; readonly baseURL?: string | undefined; readonly endpoints?: ApiEndpointsInput | undefined }`
  - `function apiProviderEndpoints(provider: ApiEndpointsSource): readonly [NormalizedApiEndpoint, ...NormalizedApiEndpoint[]]`
  - `function validateApiEndpoints(provider: { readonly kind?: unknown; readonly protocol?: unknown; readonly baseURL?: unknown; readonly endpoints?: unknown }, ctx: z.RefinementCtx): void`
- 循环依赖约束：`provider-endpoints` 只 import `zod` 与 `es-toolkit/predicate`，**不得** import `./provider`（否则模块环导致 TDZ）。`provider.ts` 单向 import 它。

- [ ] **Step 1: 写归一化与校验的失败测试**

`packages/types/src/provider-endpoints/provider-endpoints.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  ApiEndpointsInputSchema,
  apiProviderEndpoints,
  ProviderProtocol,
  validateApiEndpoints,
} from './provider-endpoints';

const issuesOf = (provider: unknown): readonly string[] => {
  const collected: string[] = [];
  const ctx = {
    addIssue: (issue: { readonly message?: string }) => {
      collected.push(issue.message ?? '');
    },
  } as unknown as z.RefinementCtx;
  validateApiEndpoints(provider as never, ctx);
  return collected;
};

describe('apiProviderEndpoints', () => {
  test('legacy pair alone normalizes to a single origin endpoint', () => {
    expect(
      apiProviderEndpoints({ protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://api.openai.com/v1' }),
    ).toEqual([{ protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://api.openai.com/v1', mode: 'origin' }]);
  });

  test('legacy pair merges before endpoints entries and keeps entry auth', () => {
    const endpoints = apiProviderEndpoints({
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.moonshot.cn/v1',
      endpoints: [
        { protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.moonshot.cn/anthropic/v1', auth: 'bearer' },
      ],
    });
    expect(endpoints).toEqual([
      { protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://api.moonshot.cn/v1', mode: 'origin' },
      {
        protocol: ProviderProtocol.Anthropic,
        baseURL: 'https://api.moonshot.cn/anthropic/v1',
        auth: 'bearer',
        mode: 'sdk',
      },
    ]);
  });

  test('shared object expands per protocol in order with sdk mode', () => {
    expect(
      apiProviderEndpoints({
        endpoints: {
          baseURL: 'https://gw.example.com/v1',
          protocol: [ProviderProtocol.OpenAIResponse, ProviderProtocol.Anthropic],
        },
      }),
    ).toEqual([
      { protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://gw.example.com/v1', mode: 'sdk' },
      { protocol: ProviderProtocol.Anthropic, baseURL: 'https://gw.example.com/v1', mode: 'sdk' },
    ]);
  });

  test('throws when no endpoint is declared', () => {
    expect(() => apiProviderEndpoints({})).toThrow(TypeError);
  });
});

describe('validateApiEndpoints', () => {
  test('ignores non-api providers', () => {
    expect(issuesOf({ kind: 'oauth' })).toEqual([]);
  });

  test('rejects a lone protocol or lone baseURL', () => {
    expect(issuesOf({ kind: 'api', protocol: 'anthropic' })).toEqual(['protocol and baseURL must be provided together']);
    expect(issuesOf({ kind: 'api', baseURL: 'https://a.test' })).toEqual([
      'protocol and baseURL must be provided together',
    ]);
  });

  test('requires the legacy pair or endpoints', () => {
    expect(issuesOf({ kind: 'api' })).toEqual(['protocol/baseURL or endpoints is required']);
  });

  test('rejects duplicate protocols across the legacy pair and endpoints', () => {
    expect(
      issuesOf({
        kind: 'api',
        protocol: 'anthropic',
        baseURL: 'https://a.test',
        endpoints: [{ protocol: 'anthropic', baseURL: 'https://b.test' }],
      }),
    ).toEqual(['Duplicate endpoint protocol "anthropic"']);
  });

  test('rejects duplicate protocols inside the shared object', () => {
    expect(
      issuesOf({ kind: 'api', endpoints: { baseURL: 'https://gw.test/v1', protocol: ['anthropic', 'anthropic'] } }),
    ).toEqual(['Duplicate endpoint protocol "anthropic"']);
  });

  test('rejects auth on a non-anthropic entry', () => {
    expect(
      issuesOf({ kind: 'api', endpoints: [{ protocol: 'gemini', baseURL: 'https://g.test', auth: 'bearer' }] }),
    ).toEqual(['auth is only supported on anthropic endpoints']);
  });

  test('skips template strings so authoring configs validate after expansion', () => {
    expect(
      issuesOf({
        kind: 'api',
        protocol: 'anthropic',
        baseURL: 'https://a.test',
        endpoints: [{ protocol: '{{env.PROTO}}', baseURL: 'https://b.test' }],
      }),
    ).toEqual([]);
  });
});

describe('ApiEndpointsInputSchema', () => {
  test('rejects an empty array and an empty shared protocol list', () => {
    expect(ApiEndpointsInputSchema.safeParse([]).success).toBeFalse();
    expect(ApiEndpointsInputSchema.safeParse({ baseURL: 'https://gw.test/v1', protocol: [] }).success).toBeFalse();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/types/src/provider-endpoints/provider-endpoints.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现模块**

`packages/types/src/provider-endpoints/provider-endpoints.ts`：

```ts
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

export enum ProviderProtocol {
  OpenAIResponse = 'openai-response',
  OpenAICompatible = 'openai-compatible',
  Anthropic = 'anthropic',
  Gemini = 'gemini',
}

export const ProviderProtocolSchema = z
  .enum(ProviderProtocol)
  .describe('Wire protocol supported by this provider base URL.');

export const ProviderEndpointAuthSchema = z
  .enum(['bearer', 'x-api-key'])
  .describe('Anthropic endpoints only: bearer sends Authorization, x-api-key (default) sends x-api-key.');

export type ProviderEndpointAuth = z.output<typeof ProviderEndpointAuthSchema>;

export const ApiEndpointEntrySchema = z.object({
  protocol: ProviderProtocolSchema,
  baseURL: z.url().describe('AI SDK-style base URL for this protocol endpoint.'),
  auth: ProviderEndpointAuthSchema.optional(),
});

export const ApiEndpointsInputSchema = z
  .union([
    z.array(ApiEndpointEntrySchema).min(1),
    z.object({
      baseURL: z.url().describe('AI SDK-style base URL shared by every listed protocol.'),
      protocol: z.array(ProviderProtocolSchema).min(1),
    }),
  ])
  .describe('Additional protocol endpoints natively served by this provider.');

export type ApiEndpointEntry = z.output<typeof ApiEndpointEntrySchema>;
export type ApiEndpointsInput = z.output<typeof ApiEndpointsInputSchema>;

export type NormalizedApiEndpoint = {
  readonly protocol: ProviderProtocol;
  readonly baseURL: string;
  readonly auth?: ProviderEndpointAuth;
  readonly mode: 'origin' | 'sdk';
};

export type ApiEndpointsSource = {
  readonly protocol?: ProviderProtocol | undefined;
  readonly baseURL?: string | undefined;
  readonly endpoints?: ApiEndpointsInput | undefined;
};

export function apiProviderEndpoints(
  provider: ApiEndpointsSource,
): readonly [NormalizedApiEndpoint, ...NormalizedApiEndpoint[]] {
  const endpoints: NormalizedApiEndpoint[] = [];
  if (provider.protocol !== undefined && provider.baseURL !== undefined) {
    endpoints.push({ protocol: provider.protocol, baseURL: provider.baseURL, mode: 'origin' });
  }
  endpoints.push(...expandedEntries(provider.endpoints));
  const [primary, ...rest] = endpoints;
  if (primary === undefined) throw new TypeError('API provider declares no protocol endpoint');
  return [primary, ...rest];
}

function expandedEntries(input: ApiEndpointsInput | undefined): readonly NormalizedApiEndpoint[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) {
    return input.map((entry) => ({
      protocol: entry.protocol,
      baseURL: entry.baseURL,
      ...(entry.auth === undefined ? {} : { auth: entry.auth }),
      mode: 'sdk' as const,
    }));
  }
  return input.protocol.map((protocol) => ({ protocol, baseURL: input.baseURL, mode: 'sdk' as const }));
}

type EndpointsValidationSource = {
  readonly kind?: unknown;
  readonly protocol?: unknown;
  readonly baseURL?: unknown;
  readonly endpoints?: unknown;
};

export function validateApiEndpoints(provider: EndpointsValidationSource, ctx: z.RefinementCtx): void {
  if (provider.kind !== 'api') return;
  const hasProtocol = provider.protocol !== undefined;
  const hasBaseUrl = provider.baseURL !== undefined;
  if (hasProtocol !== hasBaseUrl) {
    ctx.addIssue({
      code: 'custom',
      message: 'protocol and baseURL must be provided together',
      path: [hasProtocol ? 'baseURL' : 'protocol'],
    });
    return;
  }
  if (provider.endpoints === undefined) {
    if (!hasProtocol) {
      ctx.addIssue({ code: 'custom', message: 'protocol/baseURL or endpoints is required', path: ['protocol'] });
    }
    return;
  }
  const seen = new Set<string>();
  const legacyProtocol = concreteProtocol(provider.protocol);
  if (legacyProtocol !== undefined) seen.add(legacyProtocol);
  for (const entry of endpointValidationEntries(provider.endpoints)) {
    if (entry.protocol !== undefined) {
      if (seen.has(entry.protocol)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate endpoint protocol "${entry.protocol}"`,
          path: entry.protocolPath,
        });
      }
      seen.add(entry.protocol);
      if (entry.auth !== undefined && entry.protocol !== ProviderProtocol.Anthropic) {
        ctx.addIssue({
          code: 'custom',
          message: 'auth is only supported on anthropic endpoints',
          path: entry.authPath,
        });
      }
    }
  }
}

type EndpointValidationEntry = {
  readonly protocol: string | undefined;
  readonly auth: unknown;
  readonly protocolPath: readonly (string | number)[];
  readonly authPath: readonly (string | number)[];
};

const PROTOCOL_VALUES = new Set<string>(Object.values(ProviderProtocol));

// Authoring configs may still hold `{{env.NAME}}` template strings; those are
// validated again after expansion, so non-enum strings are skipped here.
function concreteProtocol(value: unknown): string | undefined {
  return typeof value === 'string' && PROTOCOL_VALUES.has(value) ? value : undefined;
}

function endpointValidationEntries(endpoints: unknown): readonly EndpointValidationEntry[] {
  if (Array.isArray(endpoints)) {
    return endpoints.map((entry, index) => ({
      protocol: concreteProtocol(isPlainObject(entry) ? entry['protocol'] : undefined),
      auth: isPlainObject(entry) ? entry['auth'] : undefined,
      protocolPath: ['endpoints', index, 'protocol'],
      authPath: ['endpoints', index, 'auth'],
    }));
  }
  if (isPlainObject(endpoints) && Array.isArray(endpoints['protocol'])) {
    return endpoints['protocol'].map((value, index) => ({
      protocol: concreteProtocol(value),
      auth: undefined,
      protocolPath: ['endpoints', 'protocol', index],
      authPath: ['endpoints', 'protocol', index],
    }));
  }
  return [];
}
```

`packages/types/src/provider-endpoints/index.ts`：

```ts
export {
  type ApiEndpointEntry,
  ApiEndpointEntrySchema,
  type ApiEndpointsInput,
  ApiEndpointsInputSchema,
  type ApiEndpointsSource,
  apiProviderEndpoints,
  type NormalizedApiEndpoint,
  type ProviderEndpointAuth,
  ProviderEndpointAuthSchema,
  ProviderProtocol,
  ProviderProtocolSchema,
  validateApiEndpoints,
} from './provider-endpoints';
```

- [ ] **Step 4: `provider.ts` 迁移枚举**

在 `packages/types/src/provider.ts` 中删除 `export enum ProviderProtocol {...}` 与 `export const ProviderProtocolSchema = ...`（当前第 17-26 行），顶部加：

```ts
import { ProviderProtocolSchema } from './provider-endpoints/index';

export {
  type ApiEndpointEntry,
  ApiEndpointEntrySchema,
  type ApiEndpointsInput,
  ApiEndpointsInputSchema,
  type ApiEndpointsSource,
  apiProviderEndpoints,
  type NormalizedApiEndpoint,
  type ProviderEndpointAuth,
  ProviderEndpointAuthSchema,
  ProviderProtocol,
  ProviderProtocolSchema,
  validateApiEndpoints,
} from './provider-endpoints/index';
```

注意：包公共入口 `packages/types/src/index.ts` 只有 `export * from './provider'`，**不要**再从 index 直接 `export * from './provider-endpoints/index'`（两处星号导出同名符号会造成 ESM ambiguous re-export 被静默丢弃）。仓内所有 `from '@aio-proxy/types'` 与 `from '../provider'` 的既有 import 因具名 re-export 不受影响。

- [ ] **Step 5: 运行测试与包内全测**

Run: `bun test packages/types/src/provider-endpoints/provider-endpoints.test.ts && (cd packages/types && bun run test:unit)`
Expected: 全部 PASS（枚举迁移不改变任何公共 API）。

- [ ] **Step 6: 全仓类型与 lint 快查后提交**

Run: `bun run check`
Expected: PASS。

```bash
git add packages/types
git commit -m "feat(types): add provider endpoint normalization module"
```

---

### Task 2: core `createApiProvider` 按端点产出 transports（sdk 拼接 + per-endpoint 鉴权）

**Files:**
- Modify: `packages/core/src/provider/api/api.ts`
- Modify: `packages/core/src/provider/api/index.ts`
- Create: `packages/core/src/provider/api/api-endpoints.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `apiProviderEndpoints` / `NormalizedApiEndpoint` / `ApiEndpointsSource` / `ProviderProtocol`（自 `@aio-proxy/types`）。
- Produces:
  - `type ApiEndpointTransport = { readonly protocol: ProviderProtocol; readonly passthrough: (req: Request, options?: RawTransportOptions) => Promise<Response> }`
  - `ApiProviderInstance` 新增 `readonly endpointTransports: readonly [ApiEndpointTransport, ...ApiEndpointTransport[]]`；保留 `passthrough`（恒等于 `endpointTransports[0].passthrough`，probe 与既有测试继续使用）。
  - `ApiProviderConfig = ApiProvider & ApiEndpointsSource & { readonly trace?: ApiProviderTraceTarget }`（翻转前即可在测试里传 `endpoints`）。

- [ ] **Step 1: 写失败测试**

`packages/core/src/provider/api/api-endpoints.test.ts`（用 mock fetch 断言最终 URL 与 header；构造 provider 用"旧字段主端点 + endpoints 附加"的合并形态，翻转可选性前 `ApiProvider` 仍要求旧字段）：

```ts
import { expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createApiProvider } from './api';

type Captured = { readonly url: string; readonly headers: Headers };

function capturingFetch(captured: Captured[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;
}

const provider = {
  apiKey: 'k',
  baseURL: 'https://api.z.ai/api/paas/v4',
  enabled: true,
  id: 'zai',
  kind: ProviderKind.Api,
  models: ['glm-4.7'],
  protocol: ProviderProtocol.OpenAICompatible,
  endpoints: [
    { protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.z.ai/api/anthropic/v1', auth: 'bearer' },
    { protocol: ProviderProtocol.Gemini, baseURL: 'https://g.example.com/v1beta' },
  ],
} as const;

test('primary transport keeps frozen origin semantics and passthrough alias', async () => {
  const captured: Captured[] = [];
  const instance = createApiProvider(provider, { fetch: capturingFetch(captured) });

  expect(instance.endpointTransports.map((endpoint) => endpoint.protocol)).toEqual([
    ProviderProtocol.OpenAICompatible,
    ProviderProtocol.Anthropic,
    ProviderProtocol.Gemini,
  ]);
  await instance.passthrough(
    new Request('http://proxy.local/v1/chat/completions?a=1', { method: 'POST', body: '{}' }),
    { upstreamStream: false },
  );
  // origin 模式冻结现状：丢弃 baseURL 的 /api/paas/v4 前缀。
  expect(captured[0]?.url).toBe('https://api.z.ai/v1/chat/completions?a=1');
  expect(captured[0]?.headers.get('authorization')).toBe('Bearer k');
});

test('sdk anthropic endpoint joins operation path and honors bearer auth', async () => {
  const captured: Captured[] = [];
  const instance = createApiProvider(provider, { fetch: capturingFetch(captured) });
  const anthropic = instance.endpointTransports.find((e) => e.protocol === ProviderProtocol.Anthropic);

  await anthropic?.passthrough(
    new Request('http://proxy.local/v1/messages', { method: 'POST', body: '{}' }),
    { upstreamStream: false },
  );
  await anthropic?.passthrough(
    new Request('http://proxy.local/v1/messages/count_tokens', { method: 'POST', body: '{}' }),
    { upstreamStream: false },
  );

  expect(captured[0]?.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
  expect(captured[0]?.headers.get('authorization')).toBe('Bearer k');
  expect(captured[0]?.headers.get('x-api-key')).toBeNull();
  expect(captured[1]?.url).toBe('https://api.z.ai/api/anthropic/v1/messages/count_tokens');
});

test('sdk anthropic endpoint defaults to x-api-key without auth override', async () => {
  const captured: Captured[] = [];
  const instance = createApiProvider(
    {
      ...provider,
      endpoints: [{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.z.ai/api/anthropic/v1' }],
    },
    { fetch: capturingFetch(captured) },
  );
  const anthropic = instance.endpointTransports.find((e) => e.protocol === ProviderProtocol.Anthropic);
  await anthropic?.passthrough(new Request('http://proxy.local/v1/messages', { method: 'POST', body: '{}' }), {
    upstreamStream: false,
  });

  expect(captured[0]?.headers.get('x-api-key')).toBe('k');
  expect(captured[0]?.headers.get('authorization')).toBeNull();
});

test('sdk gemini endpoint strips /v1beta prefix and keeps query', async () => {
  const captured: Captured[] = [];
  const instance = createApiProvider(provider, { fetch: capturingFetch(captured) });
  const gemini = instance.endpointTransports.find((e) => e.protocol === ProviderProtocol.Gemini);
  await gemini?.passthrough(
    new Request('http://proxy.local/v1beta/models/gemini-pro:streamGenerateContent?alt=sse', {
      method: 'POST',
      body: '{}',
    }),
    { upstreamStream: false },
  );

  expect(captured[0]?.url).toBe('https://g.example.com/v1beta/models/gemini-pro%3AstreamGenerateContent?alt=sse');
  expect(captured[0]?.headers.get('x-goog-api-key')).toBe('k');
});
```

注意 gemini 断言中 `:` 的编码以实际 `URL` 序列化为准：先按 `new URL()` 行为写断言，跑失败时以实现输出修正（`URL.pathname` 会保留 `:`，若断言失败改为未编码形式 `.../gemini-pro:streamGenerateContent?alt=sse`）。

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/core/src/provider/api/api-endpoints.test.ts`
Expected: FAIL（`endpointTransports` 不存在；`endpoints` 字段类型不接受）。

- [ ] **Step 3: 改写 `api.ts`**

对 `packages/core/src/provider/api/api.ts`：

1. import 增加：`import { type ApiEndpointsSource, apiProviderEndpoints, type NormalizedApiEndpoint } from '@aio-proxy/types';`（保留现有 `ApiProvider, ProviderProtocol`）。
2. 类型变更：

```ts
export type ApiProviderConfig = ApiProvider & ApiEndpointsSource & { readonly trace?: ApiProviderTraceTarget };

export type ApiEndpointTransport = {
  readonly protocol: ProviderProtocol;
  readonly passthrough: (req: Request, options?: RawTransportOptions) => Promise<Response>;
};

export type ApiProviderInstance = ApiProvider & {
  readonly endpointTransports: readonly [ApiEndpointTransport, ...ApiEndpointTransport[]];
  /** Primary-endpoint passthrough; equals endpointTransports[0].passthrough. */
  readonly passthrough: (req: Request, options?: RawTransportOptions) => Promise<Response>;
};
```

3. `createApiProvider` 整体替换为：

```ts
export function createApiProvider(
  config: ApiProviderConfig,
  options: ApiProviderFactoryOptions = {},
): ApiProviderInstance {
  const trace = options.trace ?? config.trace;
  const fetcher = options.fetch ?? globalThis.fetch;
  const transports = apiProviderEndpoints(config).map((endpoint) =>
    endpointTransport(endpoint, config, fetcher, trace),
  );
  const [primary, ...rest] = transports;
  const { trace: _trace, ...providerFields } = config;
  return { ...providerFields, endpointTransports: [primary, ...rest], passthrough: primary.passthrough };
}

const SDK_VERSION_PREFIXES: Record<ProviderProtocol, string> = {
  [ProviderProtocol.OpenAIResponse]: '/v1',
  [ProviderProtocol.OpenAICompatible]: '/v1',
  [ProviderProtocol.Anthropic]: '/v1',
  [ProviderProtocol.Gemini]: '/v1beta',
};

function endpointTransport(
  endpoint: NormalizedApiEndpoint,
  config: Pick<ApiProviderConfig, 'apiKey' | 'headers'>,
  fetcher: ProviderFetch,
  trace: ApiProviderTraceTarget | undefined,
): ApiEndpointTransport {
  const fetchUpstream = wrapOpenAIProtocolFetch(endpoint.protocol, fetcher);
  return {
    protocol: endpoint.protocol,
    async passthrough(req, options) {
      const upstreamUrl =
        endpoint.mode === 'origin'
          ? rewrittenUrl(endpoint.baseURL, req.url)
          : sdkRewrittenUrl(endpoint.baseURL, req.url, endpoint.protocol);
      const headers = upstreamHeaders(req.headers, config, endpoint);

      const response = await fetchUpstream(
        upstreamUrl,
        { body: req.body, headers, method: req.method, signal: req.signal },
        options,
      );

      if (trace === undefined || response.body === null) {
        return new Response(response.body, decodedBodyResponseInit(response));
      }
      const [returnedBody, tracedBody] = response.body.tee();
      void recordTrace(trace, response.status, tracedBody);
      return new Response(returnedBody, decodedBodyResponseInit(response));
    },
  };
}

// sdk 模式：baseURL 即 @ai-sdk/* 的入参；剥去 inbound 标准路径的版本前缀，
// 余下操作路径拼到 baseURL path 之后（与各包自身的拼接行为一致）。
function sdkRewrittenUrl(baseURL: string, requestUrl: string, protocol: ProviderProtocol): URL {
  const incomingUrl = new URL(requestUrl);
  const prefix = SDK_VERSION_PREFIXES[protocol];
  const operationPath =
    incomingUrl.pathname === prefix || incomingUrl.pathname.startsWith(`${prefix}/`)
      ? incomingUrl.pathname.slice(prefix.length)
      : incomingUrl.pathname;
  const upstreamUrl = new URL(baseURL);
  upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/u, '')}${operationPath}`;
  upstreamUrl.search = incomingUrl.search;
  return upstreamUrl;
}
```

4. `upstreamHeaders` 第二/三参改为 config + endpoint（origin 条目无 `auth`，行为与现状逐字节一致）：

```ts
function upstreamHeaders(
  inbound: Headers,
  config: Pick<ApiProviderConfig, 'apiKey' | 'headers'>,
  endpoint: Pick<NormalizedApiEndpoint, 'protocol' | 'auth'>,
): Headers {
  const headers = new Headers(inbound);
  headers.delete('host');
  headers.delete('accept-encoding');
  for (const name of CLIENT_CREDENTIAL_HEADERS) headers.delete(name);
  const apiKey = resolveApiKey(config.apiKey);
  if (apiKey !== undefined) {
    if (endpoint.protocol === ProviderProtocol.Anthropic && endpoint.auth !== 'bearer') {
      headers.set('x-api-key', apiKey);
    } else if (endpoint.protocol === ProviderProtocol.Gemini) {
      headers.set('x-goog-api-key', apiKey);
    } else {
      headers.set('authorization', `Bearer ${apiKey}`);
    }
  }
  for (const [name, value] of Object.entries(config.headers ?? {})) headers.set(name, value);
  return headers;
}
```

5. `rewrittenUrl`、`decodedBodyResponseInit`、`resolveApiKey`、`recordTrace` 原样保留。
6. `packages/core/src/provider/api/index.ts` 的 export 列表加 `type ApiEndpointTransport`；确认 `packages/core/src/index.ts` 对 `./provider/api/index` 的再导出覆盖到它（跟随现有导出方式）。

- [ ] **Step 4: 运行 core 测试**

Run: `bun test packages/core/src/provider/api/`
Expected: 新测试与既有 `api-passthrough` / `api-stream` / `api-fetch` 等全部 PASS（`passthrough` 别名保持旧行为）。

- [ ] **Step 5: 全仓检查后提交**

Run: `bun run check && bun test packages/core`
Expected: PASS。

```bash
git add packages/core
git commit -m "feat(core): per-endpoint api transports with sdk base url semantics"
```

---

### Task 3: core `bridgeApiProviderToAiSdk` 读主端点 + anthropic bearer 走 `authToken`

**Files:**
- Modify: `packages/core/src/provider/api-bridge/api-bridge.ts`

**Interfaces:**
- Consumes: `apiProviderEndpoints`、`NormalizedApiEndpoint`。
- Produces: `bridgeApiProviderToAiSdk(provider: ApiProvider & ApiEndpointsSource, options?)` — 行为契约：桥接 baseURL = 主端点 `baseURL` 原样；主端点为 anthropic 且 `auth === 'bearer'` 时 options 含 `authToken`、不含 `apiKey`。
- 新行为的自动化测试在 Task 6（翻转可选性后才能构造"sdk 主端点"的 provider）补齐；本任务以既有桥接测试守护回归。

- [ ] **Step 1: 改写 `bridgeApiProviderToAiSdk` 与 `bridgeMapping`**

```ts
import { type ApiEndpointsSource, apiProviderEndpoints, type NormalizedApiEndpoint } from '@aio-proxy/types';

export function bridgeApiProviderToAiSdk(
  provider: ApiProvider & ApiEndpointsSource,
  options: AiSdkProviderFactoryOptions = {},
): AiSdkProviderInstance {
  const primary = apiProviderEndpoints(provider)[0];
  const providerId = provider.id;
  const mapping = bridgeMapping(provider, primary, providerId);
  const synthesized = {
    kind: ProviderKind.AiSdk,
    enabled: provider.enabled,
    id: `${providerId}:bridge`,
    packageName: mapping.packageName,
    options: mapping.options,
    ...(provider.models === undefined ? {} : { models: provider.models }),
    ...(provider.alias === undefined ? {} : { alias: provider.alias }),
  } satisfies AiSdkProvider;

  return createAiSdkProvider(synthesized, {
    ...options,
    ...(mapping.resolveModel === undefined ? {} : { resolveModel: mapping.resolveModel }),
  });
}

function bridgeMapping(
  provider: ApiProvider & ApiEndpointsSource,
  primary: NormalizedApiEndpoint,
  providerId: string,
): BridgeMapping {
  const apiKey = resolveApiKey(provider.apiKey);
  const sharedOptions = {
    ...(apiKey === undefined ? {} : { apiKey }),
    baseURL: primary.baseURL,
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
  } satisfies AiSdkProviderLoadOptions;

  switch (primary.protocol) {
    case ProviderProtocol.OpenAICompatible:
      return { packageName: '@ai-sdk/openai-compatible', options: { ...sharedOptions, name: providerId } };
    case ProviderProtocol.Anthropic: {
      if (primary.auth !== 'bearer') return { packageName: '@ai-sdk/anthropic', options: sharedOptions };
      // @ai-sdk/anthropic rejects apiKey+authToken together; bearer endpoints hand the key over as authToken.
      const { apiKey: bearerToken, ...withoutApiKey } = sharedOptions;
      return {
        packageName: '@ai-sdk/anthropic',
        options: { ...withoutApiKey, ...(bearerToken === undefined ? {} : { authToken: bearerToken }) },
      };
    }
    case ProviderProtocol.Gemini:
      return { packageName: '@ai-sdk/google', options: sharedOptions };
    case ProviderProtocol.OpenAIResponse:
      return { packageName: '@ai-sdk/openai', options: sharedOptions, resolveModel: resolveOpenAIResponsesModel };
    default:
      return assertNever(primary.protocol);
  }
}
```

删除原 `const baseURL = provider.baseURL;` 与 `bridgeMapping(provider, baseURL, providerId)` 旧签名。`AiSdkProviderLoadOptions` 有 `[key: string]: unknown` 索引签名，`authToken` 直达 `createAnthropic(options)`。

- [ ] **Step 2: 运行既有桥接测试守护回归**

Run: `bun test packages/core/src/provider/api-bridge/`
Expected: 全部 PASS（旧 provider 主端点 = 旧字段，baseURL/协议映射与现状一致）。

- [ ] **Step 3: 全仓检查后提交**

Run: `bun run check`
Expected: PASS。

```bash
git add packages/core
git commit -m "feat(core): bridge api providers from their primary endpoint"
```

---

### Task 4: server `materializeRuntimeProvider` 端点集分发 + summary 主协议

**Files:**
- Modify: `packages/server/src/provider-runtime/materialize.ts`
- Modify: `packages/server/src/provider-runtime/materialize.test.ts`（扩展，已有平铺 colocated 测试）

**Interfaces:**
- Consumes: Task 2 的 `ApiProviderInstance.endpointTransports`；Task 1 的 `apiProviderEndpoints`。
- Produces: api 分支 `raw.resolve({ protocol })` 在 `endpointTransports` 中查找；`providerDisplayFields` 对 api kind 输出主端点协议。`RuntimeRawCapability` 类型不变。

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/provider-runtime/materialize.test.ts` 追加（import 处补 `createApiProvider`、`ProviderProtocol`，沿用文件既有 import 风格）：

```ts
test('api provider raw capability resolves any declared endpoint protocol', () => {
  const api = createApiProvider(
    {
      apiKey: 'k',
      baseURL: 'https://api.moonshot.cn/v1',
      enabled: true,
      id: 'moonshot',
      kind: ProviderKind.Api,
      models: ['kimi-k2'],
      protocol: ProviderProtocol.OpenAICompatible,
      endpoints: [{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.moonshot.cn/anthropic/v1' }],
    },
    { fetch: (async () => new Response('{}')) as typeof globalThis.fetch },
  );
  const instance = materializeRuntimeProvider(api);

  expect(instance.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: 'kimi-k2' })).toBeDefined();
  expect(instance.raw?.resolve({ protocol: ProviderProtocol.Anthropic, modelId: 'kimi-k2' })).toBeDefined();
  expect(instance.raw?.resolve({ protocol: ProviderProtocol.Gemini, modelId: 'kimi-k2' })).toBeUndefined();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/server/src/provider-runtime/materialize.test.ts`
Expected: 新用例 FAIL（anthropic 解析返回 undefined——现实现只比对单一 `provider.protocol`）。

- [ ] **Step 3: 实现**

`materialize.ts` api 分支（`materializeRuntimeProvider` 内）把

```ts
raw: {
  resolve: ({ protocol }) =>
    protocol === provider.protocol
      ? { invoke: (request, _context, options) => provider.passthrough(request, options) }
      : undefined,
},
```

替换为：

```ts
raw: {
  resolve: ({ protocol }) => {
    const transport = provider.endpointTransports.find((endpoint) => endpoint.protocol === protocol);
    return transport === undefined
      ? undefined
      : { invoke: (request, _context, options) => transport.passthrough(request, options) };
  },
},
```

`providerDisplayFields` 中 `...(provider.kind === ProviderKind.Api ? { protocol: provider.protocol } : {})` 替换为：

```ts
...(provider.kind === ProviderKind.Api ? { protocol: apiProviderEndpoints(provider)[0].protocol } : {}),
```

并在 import 处从 `@aio-proxy/types` 增加 `apiProviderEndpoints`。

- [ ] **Step 4: 运行测试**

Run: `bun test packages/server/src/provider-runtime/`
Expected: PASS。

- [ ] **Step 5: 全仓检查后提交**

Run: `bun run check && bun test packages/server`
Expected: PASS。

```bash
git add packages/server
git commit -m "feat(server): resolve raw dispatch across declared api endpoints"
```

---

### Task 5: server probe 标准路径化 + draft catalog / transform 上下文改读主端点

**Files:**
- Modify: `packages/server/src/provider-runtime/probe/probe.ts`
- Modify: `packages/server/src/provider-runtime/probe/probe.test.ts`
- Modify: `packages/server/src/dashboard-routes/provider-draft/provider-draft-operations.ts`
- Modify: `packages/server/src/provider-request-transform/fetch.ts`

**Interfaces:**
- Consumes: `apiProviderEndpoints`；`ApiProviderInstance.passthrough`（主端点别名）。
- Produces: `providerProbeRequest(provider, model): { readonly body: unknown; readonly path: string }`（不再返回 `url`；URL 改写唯一归端点 transport 负责，杜绝双重前缀）。

- [ ] **Step 1: 更新 probe 测试（先失败）**

`probe.test.ts` 的现有用例无需改动（`instance.passthrough` 与 URL 行为对旧 provider 不变）。追加一个断言 probe 请求经 transport 改写、无双重前缀的用例：

```ts
test('probe sends the standard inbound path through the primary endpoint transport', async () => {
  let requested: string | undefined;
  const provider = {
    apiKey: 'k',
    baseURL: 'https://api.z.ai/api/paas/v4',
    enabled: true,
    id: 'zai',
    kind: ProviderKind.Api,
    models: ['glm-4.7'],
    protocol: ProviderProtocol.OpenAICompatible,
  } as const;
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  // origin 模式冻结现状：探测打到 origin + 标准路径。
  expect(requested).toBe('https://api.z.ai/v1/chat/completions');
});
```

Run: `bun test packages/server/src/provider-runtime/probe/`
Expected: 新用例可能已 PASS（现状同 URL）——本任务的守护点是 `providerProbeRequest` 返回值重构后此用例仍 PASS。若已 PASS，继续 Step 2 重构并保持其绿。

- [ ] **Step 2: 重构 `probe.ts`**

`providerProbeRequest` 改为返回 `{ body, path }`，各分支 `url.pathname = X` 改为 `path: X`，签名与调用方：

```ts
export function providerProbeRequest(
  provider: Extract<Provider, { kind: ProviderKind.Api }>,
  model: string,
): { readonly body: unknown; readonly path: string } {
  const primary = apiProviderEndpoints(provider)[0];
  switch (primary.protocol) {
    case ProviderProtocol.OpenAICompatible:
      return {
        body: { max_tokens: probeMaxOutputTokens, messages: [{ role: 'user', content: 'ping' }], model },
        path: '/v1/chat/completions',
      };
    case ProviderProtocol.OpenAIResponse:
      return { body: { input: 'ping', max_output_tokens: openAIResponsesProbeMaxOutputTokens, model }, path: '/v1/responses' };
    case ProviderProtocol.Anthropic:
      return {
        body: { max_tokens: probeMaxOutputTokens, messages: [{ role: 'user', content: 'ping' }], model },
        path: '/v1/messages',
      };
    case ProviderProtocol.Gemini:
      return {
        body: {
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: probeMaxOutputTokens },
        },
        path: `/v1beta/models/${model}:generateContent`,
      };
    default:
      return assertNever(primary.protocol);
  }
}
```

`probeApi` 中 `new Request(request.url, ...)` 改为：

```ts
const response = await instance.passthrough(
  new Request(new URL(request.path, 'http://probe.internal'), {
    body: JSON.stringify(request.body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(1_000),
  }),
  { upstreamStream: false },
);
```

import 处补 `apiProviderEndpoints`。

- [ ] **Step 3: draft catalog 与 transform 上下文改读主端点**

`provider-draft-operations.ts`：`loadProviderDraftCatalog` 内加 `const primary = apiProviderEndpoints(provider)[0];`，三处 `provider.protocol` → `primary.protocol`（`raw?.resolve({ protocol: primary.protocol, modelId: '' })`、`catalogPath(primary.protocol)`、`catalogPage(primary.protocol, ...)`）。`withDraftAttempt` 中：

```ts
const sourceProtocol =
  provider.kind === ProviderKind.Api ? apiProviderEndpoints(provider)[0].protocol : ProviderProtocol.OpenAIResponse;
```

`provider-request-transform/fetch.ts` 第 53 行 `...('protocol' in provider ? { protocol: provider.protocol } : {})` 改为：

```ts
...(provider.kind === ProviderKind.Api ? { protocol: apiProviderEndpoints(provider)[0].protocol } : {}),
```

两个文件 import 处补 `apiProviderEndpoints`（以及缺失的 `ProviderKind`）。

- [ ] **Step 4: 运行 server 测试**

Run: `bun test packages/server`
Expected: PASS。

- [ ] **Step 5: 全仓检查后提交**

Run: `bun run check`
Expected: PASS。

```bash
git add packages/server
git commit -m "refactor(server): read primary api endpoint via normalization helper"
```

---

### Task 6: types schema 翻转（`endpoints` 字段 + 可选旧字段 + refine 接线）与验收测试

**Files:**
- Modify: `packages/types/src/provider.ts`
- Modify: `packages/types/src/config/config.ts`
- Create: `packages/types/src/config/config-acceptance.endpoints.test.ts`
- Modify: `packages/core/src/provider/api/api.ts`、`packages/core/src/provider/api-bridge/api-bridge.ts`（去掉临时 `& ApiEndpointsSource`，`ApiProvider` 已含 `endpoints`）
- Modify: `packages/core/src/provider/api-bridge/api-bridge.test.ts`（追加 bearer / endpoints-only 用例）

**Interfaces:**
- Consumes: Task 1 的 `ApiEndpointsInputSchema`、`validateApiEndpoints`；Task 2-5 已让所有运行时读取点走 helper。
- Produces: `ApiProviderSchema`/`ApiProviderAuthoringSchema` 含可选 `protocol`、`baseURL`、`endpoints`；`ProviderSchema` 与 config 的两个 union 均链上 `.superRefine(validateApiEndpoints)`。mutation schema 不变。

- [ ] **Step 1: 写 config 验收失败测试**

`packages/types/src/config/config-acceptance.endpoints.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';

import { apiProviderEndpoints, ProviderKind, ProviderProtocol } from '../provider';
import { ConfigSchema } from './config';

const baseConfig = (provider: Record<string, unknown>) => ({
  providers: { p: { kind: 'api', apiKey: 'k', models: ['m'], ...provider } },
});

const parsedProvider = (provider: Record<string, unknown>) => {
  const config = ConfigSchema.parse(baseConfig(provider));
  expect(config.invalidProviders).toEqual([]);
  const parsed = config.providers[0];
  if (parsed?.kind !== ProviderKind.Api) throw new Error('expected api provider');
  return parsed;
};

const invalidPaths = (provider: Record<string, unknown>) => {
  const config = ConfigSchema.parse(baseConfig(provider));
  expect(config.providers).toEqual([]);
  return config.invalidProviders[0]?.issuePaths ?? [];
};

describe('endpoints acceptance', () => {
  test('legacy-only provider parses exactly as before', () => {
    const provider = parsedProvider({ protocol: 'openai-response', baseURL: 'https://api.openai.com/v1' });
    expect(provider.protocol).toBe(ProviderProtocol.OpenAIResponse);
    expect(provider.baseURL).toBe('https://api.openai.com/v1');
    expect(provider.endpoints).toBeUndefined();
    expect(apiProviderEndpoints(provider)).toEqual([
      { protocol: ProviderProtocol.OpenAIResponse, baseURL: 'https://api.openai.com/v1', mode: 'origin' },
    ]);
  });

  test('merge form keeps the legacy pair as the primary endpoint', () => {
    const provider = parsedProvider({
      protocol: 'openai-compatible',
      baseURL: 'https://api.moonshot.cn/v1',
      endpoints: [{ protocol: 'anthropic', baseURL: 'https://api.moonshot.cn/anthropic/v1', auth: 'bearer' }],
    });
    expect(apiProviderEndpoints(provider).map((endpoint) => [endpoint.protocol, endpoint.mode])).toEqual([
      [ProviderProtocol.OpenAICompatible, 'origin'],
      [ProviderProtocol.Anthropic, 'sdk'],
    ]);
  });

  test('endpoints-only array form parses without the legacy pair', () => {
    const provider = parsedProvider({
      endpoints: [
        { protocol: 'openai-compatible', baseURL: 'https://api.z.ai/api/paas/v4' },
        { protocol: 'anthropic', baseURL: 'https://api.z.ai/api/anthropic/v1', auth: 'bearer' },
      ],
    });
    expect(provider.protocol).toBeUndefined();
    expect(apiProviderEndpoints(provider)[0]).toEqual({
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL: 'https://api.z.ai/api/paas/v4',
      mode: 'sdk',
    });
  });

  test('shared object form expands in declared order', () => {
    const provider = parsedProvider({
      endpoints: { baseURL: 'https://gw.example.com/v1', protocol: ['openai-response', 'anthropic'] },
    });
    expect(apiProviderEndpoints(provider).map((endpoint) => endpoint.protocol)).toEqual([
      ProviderProtocol.OpenAIResponse,
      ProviderProtocol.Anthropic,
    ]);
  });

  test.each([
    { name: 'lone protocol', provider: { protocol: 'anthropic' } },
    { name: 'lone baseURL', provider: { baseURL: 'https://a.test' } },
    { name: 'missing everything', provider: {} },
    {
      name: 'duplicate protocol across legacy and endpoints',
      provider: {
        protocol: 'anthropic',
        baseURL: 'https://a.test',
        endpoints: [{ protocol: 'anthropic', baseURL: 'https://b.test' }],
      },
    },
    { name: 'empty endpoints array', provider: { endpoints: [] } },
    {
      name: 'auth on non-anthropic endpoint',
      provider: { endpoints: [{ protocol: 'gemini', baseURL: 'https://g.test/v1beta', auth: 'bearer' }] },
    },
  ])('rejects $name into invalidProviders', ({ provider }) => {
    expect(invalidPaths(provider).length).toBeGreaterThan(0);
  });

  test('mutation body schema silently strips endpoints (documented dashboard limitation)', async () => {
    const { ProviderMutationBodySchema } = await import('../provider');
    const parsed = ProviderMutationBodySchema.parse({
      kind: 'api',
      id: 'p',
      protocol: 'openai-response',
      baseURL: 'https://api.openai.com/v1',
      proxy: null,
      endpoints: [{ protocol: 'anthropic', baseURL: 'https://a.test/v1' }],
    });
    expect('endpoints' in parsed).toBeFalse();
  });
});
```

再在同文件补模板展开用例（走 `parseRuntimeConfig` 属于 core 包，types 内用 authoring schema 验证形状即可）：

```ts
test('authoring schema accepts template strings inside endpoints', async () => {
  const { ConfigAuthoringSchema } = await import('./config');
  const parsed = ConfigAuthoringSchema.safeParse({
    providers: {
      p: {
        kind: 'api',
        apiKey: '{{env.KEY}}',
        models: ['m'],
        endpoints: [{ protocol: '{{env.PROTO}}', baseURL: '{{env.BASE}}', auth: '{{env.AUTH}}' }],
      },
    },
  });
  expect(parsed.success).toBeTrue();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test packages/types/src/config/config-acceptance.endpoints.test.ts`
Expected: FAIL（`endpoints` 未知字段被 strip、可选性未翻转、refine 未接线）。

- [ ] **Step 3: 翻转 schema**

`packages/types/src/provider.ts`：

1. import 增补：`ApiEndpointsInputSchema`、`ProviderEndpointAuthSchema`、`validateApiEndpoints`（来自 `./provider-endpoints/index`）。
2. `ApiProviderSharedFields`：`protocol: ProviderProtocolSchema` → `protocol: ProviderProtocolSchema.optional()`，并新增 `endpoints: ApiEndpointsInputSchema.optional()`。
3. `ApiProviderSchema`：`baseURL: z.url().describe(...)` → `baseURL: z.url().optional().describe('Provider API base URL (primary endpoint, legacy origin semantics).')`。
4. `ApiProviderAuthoringSchema`：`.omit({...})` 列表加 `endpoints: true`，extend 中：

```ts
protocol: z.union([ProviderProtocolSchema, ConfigTemplateStringSchema]).optional(),
baseURL: z.union([z.url(), ConfigTemplateStringSchema]).optional().describe('Provider API base URL.'),
endpoints: ApiEndpointsAuthoringInputSchema.optional(),
```

并在文件内（`ApiProviderAuthoringSchema` 之前）定义：

```ts
const ApiEndpointEntryAuthoringSchema = z.object({
  protocol: z.union([ProviderProtocolSchema, ConfigTemplateStringSchema]),
  baseURL: z.union([z.url(), ConfigTemplateStringSchema]),
  auth: z.union([ProviderEndpointAuthSchema, ConfigTemplateStringSchema]).optional(),
});

const ApiEndpointsAuthoringInputSchema = z.union([
  z.array(ApiEndpointEntryAuthoringSchema).min(1),
  z.object({
    baseURL: z.union([z.url(), ConfigTemplateStringSchema]),
    protocol: z.array(z.union([ProviderProtocolSchema, ConfigTemplateStringSchema])).min(1),
  }),
]);
```

5. `ProviderSchema`（文件底部 union）：`.superRefine(validateAliasTargets)` 后链 `.superRefine(validateApiEndpoints)`（在 `.transform(normalizeProviderAlias)` 之前）。
6. mutation schema 不动（`ApiProviderMutationSharedFields.protocol` 保持必填）。

`packages/types/src/config/config.ts`：`ProviderInputValueSchema` 与 `ProviderAuthoringInputValueSchema` 均在 `.superRefine(validateAliasTargets)` 后链 `.superRefine(validateApiEndpoints)`（import 自 `../provider`）。

- [ ] **Step 4: 简化 Task 2/3 的临时交叉类型**

`ApiProvider` 现已含 `endpoints`，将 `packages/core/src/provider/api/api.ts` 的 `ApiProviderConfig = ApiProvider & ApiEndpointsSource & {...}` 改回 `ApiProvider & { readonly trace?: ApiProviderTraceTarget }`；`api-bridge.ts` 的参数类型 `ApiProvider & ApiEndpointsSource` 改回 `ApiProvider`（同时删除两处未用的 `ApiEndpointsSource` import）。

- [ ] **Step 5: 补桥接 bearer 行为测试**

在 `packages/core/src/provider/api-bridge/api-bridge.test.ts` 追加两用例：镜像该文件现有的"注入 fetch 捕获上游请求"测试骨架（保持既有 helper/断言风格），fixture 与断言为：

- endpoints-only anthropic bearer：`{ kind: api, id: 'zai', enabled: true, apiKey: 'k', models: ['glm-4.7'], endpoints: [{ protocol: 'anthropic', baseURL: 'https://api.z.ai/api/anthropic/v1', auth: 'bearer' }] }` → 触发一次模型调用后，捕获请求 URL 以 `https://api.z.ai/api/anthropic/v1/messages` 开头、`authorization` 为 `Bearer k`、无 `x-api-key`。
- endpoints-only openai-compatible：`endpoints: [{ protocol: 'openai-compatible', baseURL: 'https://gw.example.com/v1' }]` → 捕获请求 URL 以 `https://gw.example.com/v1/chat/completions` 开头。

- [ ] **Step 6: 运行全部相关测试**

Run: `bun test packages/types && bun test packages/core && bun test packages/server`
Expected: PASS（含 Task 1 归一化测试、Task 2 transports 测试、config 验收、桥接 bearer）。

- [ ] **Step 7: 全仓检查后提交**

Run: `bun run check`
Expected: PASS。

```bash
git add packages/types packages/core packages/server
git commit -m "feat(types): accept multi-protocol endpoints on api providers"
```

---

### Task 7: 文档 + 中文 README 重命名 + changeset

**Files:**
- Rename: `READNE.zh-Hans.md` → `README.zh-Hans.md`（`git mv`）
- Modify: `npm/aio-proxy/README.md`（第 3 行链接 + Configuration 节新增小节；根 `README.md` 是符号链接自动生效）
- Modify: `README.zh-Hans.md`（同步中文小节 + 自身页首英文链接核对）
- Modify: `website/docs/en/guide/start/getting-started.mdx`、`website/docs/zh/guide/start/getting-started.mdx`
- Create: `.changeset/api-provider-multi-protocol-endpoints.md`

- [ ] **Step 1: 重命名并修链接**

```bash
git mv READNE.zh-Hans.md README.zh-Hans.md
```

`npm/aio-proxy/README.md` 第 3 行 `.../blob/main/READNE.zh-Hans.md` → `.../blob/main/README.zh-Hans.md`。运行 `rg -n "READNE" --hidden -g '!node_modules'` 确认仅剩 spec/plan 文档中的历史记述。

- [ ] **Step 2: README 英文小节**

在 `npm/aio-proxy/README.md` 的 "Validate or reload the configuration" 代码块与 `### Model metadata and pricing` 之间（现第 98 行 `Editors that support...` 段后）插入：

````markdown
### Multi-protocol endpoints

Some upstreams natively serve more than one protocol. Declare the extra endpoints with `endpoints`; a request whose inbound protocol matches any declared endpoint is forwarded verbatim (raw passthrough) instead of being converted:

```jsonc
{
  "providers": {
    // First-party channel: per-protocol endpoints. Keep the legacy pair as the
    // primary endpoint and append the extra protocols.
    "moonshot": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "https://api.moonshot.cn/v1",
      "apiKey": "{{env.MOONSHOT_API_KEY}}",
      "models": ["kimi-k2"],
      "endpoints": [{ "protocol": "anthropic", "baseURL": "https://api.moonshot.cn/anthropic/v1", "auth": "bearer" }],
    },
    // Aggregator gateway: one AI SDK-style base URL shared by several protocols.
    "gateway": {
      "kind": "api",
      "apiKey": "{{env.GATEWAY_KEY}}",
      "models": ["gpt-5"],
      "endpoints": { "baseURL": "https://gw.example.com/v1", "protocol": ["openai-response", "anthropic"] },
    },
  },
}
```

Rules:

- An endpoint `baseURL` is exactly what you would pass to the matching AI SDK package: OpenAI-style and Anthropic endpoints include the `/v1` segment, Gemini endpoints include `/v1beta` (so Gemini cannot share a `/v1` base URL — give it its own array entry).
- Vendor docs often quote the Anthropic base for `ANTHROPIC_BASE_URL` (for example `https://api.z.ai/api/anthropic`); append `/v1` when copying it here.
- `auth` is accepted on `anthropic` endpoints only: `bearer` sends `Authorization: Bearer`, the default `x-api-key` keeps today's header.
- The top-level `protocol`/`baseURL` pair stays the primary endpoint and keeps its historical passthrough behavior; cross-protocol conversion always targets the primary endpoint.
- Editing a provider that declares `endpoints` from the Dashboard currently drops the field; edit the config file directly until Dashboard support lands.
````

- [ ] **Step 3: 中文 README 小节**

`README.zh-Hans.md` 在其配置示例（第 ~87 行代码块）与下一节之间插入等价中文内容（标题 `### 多协议端点`，正文为上述英文小节的中文翻译，示例代码块相同）。

- [ ] **Step 4: website 快速上手（en/zh）**

`website/docs/en/guide/start/getting-started.mdx` 在 `You can add more providers for the same model later.`（第 77 行）之后插入简短提示：

````markdown
> Upstreams that natively serve several protocols (Moonshot, z.ai, aggregator gateways, ...) can declare extra `endpoints` so matching requests are forwarded verbatim instead of converted. See the README's "Multi-protocol endpoints" section for the full rules.
````

`website/docs/zh/guide/start/getting-started.mdx` 对应位置插入中文版提示。

- [ ] **Step 5: changeset**

`.changeset/api-provider-multi-protocol-endpoints.md`：

```markdown
---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
---

API providers can declare multi-protocol `endpoints` (per-protocol or shared AI SDK-style base URLs). Raw passthrough now matches any natively supported protocol, Anthropic endpoints accept `auth: "bearer"`, and cross-protocol conversion keeps targeting the primary endpoint.
```

- [ ] **Step 6: 提交**

Run: `rg -n "READNE" npm README.zh-Hans.md website`
Expected: 无输出。

```bash
git add -A
git commit -m "docs: document multi-protocol endpoints and fix zh readme filename"
```

---

### Task 8: 收尾（preflight + PR 描述草稿）

- [ ] **Step 1: preflight**

Run: `bun run preflight`
Expected: oxlint、oxfmt、全部单测 PASS。若有 lint/format 修复，修完重跑并 `git commit -m "chore: preflight fixes"`。

- [ ] **Step 2: 起草 PR 描述（交付给用户，不自行开 PR）**

PR 描述必须包含 dashboard 交接段（spec 的既定决定）：

```markdown
## Known limitation — Dashboard handoff

`endpoints` is intentionally NOT part of the provider mutation schema or the
dashboard form in this PR. Editing a provider that declares `endpoints` from
the Dashboard rewrites the entry without the field (replaceProvider rebuilds
the provider from the mutation body and `endpoints` is not on its retention
list) — the multi-protocol configuration is silently lost.

Repro: configure a provider with `endpoints` in config.jsonc → Dashboard →
edit that provider (e.g. rename) → save → `endpoints` is gone from the file.

Owner: the in-flight dashboard refactor should add `endpoints` to the
mutation schema / retention and expose endpoint editing in the form.
```

- [ ] **Step 3: 汇报**

向用户汇报：变更摘要、测试结果、PR 描述草稿位置，等待 review。

---

## Self-Review 记录

- Spec 覆盖：配置契约（Task 1/6）、两种解释模式与操作路径表（Task 2）、鉴权（Task 2 raw / Task 3+6 bridge）、raw 匹配与分发（Task 4）、probe（Task 5）、draft/transform 读取点（Task 5）、文档与重命名（Task 7）、changeset（Task 7）、PR 交接（Task 8）、"仅解析校验、无 transform、无镜像"（Task 1/6 结构本身）。
- 类型一致性：`apiProviderEndpoints` / `NormalizedApiEndpoint` / `ApiEndpointsSource` / `ApiEndpointTransport` / `endpointTransports` / `providerProbeRequest` 返回值在各任务 Interfaces 与代码块中签名一致。
- 顺序保证：Task 2-5 均以 helper 读取（兼容翻转前后），Task 6 翻转时无残留 `provider.protocol` 直读点（`materialize`、`probe`、`draft`、`transform fetch`、`api.ts`、`api-bridge.ts` 已全部改造）。
