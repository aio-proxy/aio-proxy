# Cursor OAuth Protocol Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Cursor OAuth 已确认的协议挂起、工具参数/批次丢失及历史续接缺口，保证真实 Responses 输出完整并能及时终止。

**Architecture:** 保留每次客户端请求对应一个 Cursor Run、工具交接后取消并重建的架构。使用小型协议回复模块、MCP 状态归约器、单次终止与计时协作者，继续调用现有 AI SDK 和 egress。交接时保存模型可读取的结构化历史，日志经既有 PluginApi.logger 注入。

**Tech Stack:** Bun、TypeScript、bun:test、AI SDK V4、@bufbuild/protobuf、protoc-gen-es 2.10.2、Node HTTP/2、现有 Plugin SDK Logger。

**Spec:** [Cursor OAuth 协议可靠性修复 Spec](../specs/2026-09-07-cursor-oauth-protocol-reliability-design.md)

## Global Constraints

- 保持 Bun >=1.4.2（packageManager bun@1.4.2）、TypeScript ^7.0.2、AI SDK 7.0.8 / @ai-sdk/provider 4.0.1（V4）及 @bufbuild/protobuf ^2.14.1；不新增运行时依赖，不修改已有版本下限。
- 所有 shell 命令以 rtk 开头；命令均在当前 checkout 的仓库根目录运行（rtk proxy git rev-parse --show-toplevel）。
- 保留 server pipeline 唯一生成候选循环、统一协议 egress、Provider affinity/revision 校验和账户隔离；本次不修改 Plugin SDK 公共接口。
- 每个客户端请求最多启动一次 Cursor Run；插件内部不新增透明重试、故障转移或工具执行。
- 公共工具调用 ID 优先使用交接前已观察到的 outer call ID，缺失时使用 nested ID；两种身份分开索引，不得按工具名称配对。
- 保留前序参数合并与续接修复；已缓存的结构化参数不得被完成帧中降级的字符串覆盖。
- 手写非测试实现文件不得超过 500 行，达到 400 行先按职责拆分；新增测试与所属模块同目录，不增加 legacy _test/ 测试。
- JSON 形状检查使用 es-toolkit/predicate 的 isPlainObject；不添加通用工具依赖；控制流、流处理和状态机使用清晰的原生循环。
- 使用真实 protobuf 编解码做边界测试；时间测试使用 bun:test 的假时钟，不使用真实分钟级等待。
- 发布说明沿用 .changeset/loose-cars-hunt.md，保持 aio-proxy 和 @aio-proxy/plugin-cursor 均为 patch；正文一段且不超过 5 行。
- 实施完成运行 bun run preflight；若被未修改的既有错误阻断，至少通过 bun run check 和受影响包测试，并明确记录阻断与未执行项。
- 每个实施提交追加 Co-authored-by: Codex <noreply@openai.com>；只提交已核对属于本任务的文件。

---

## 执行基线与文件结构

本计划尚未实施。前序两处修复及 changeset 已在基线提交 ae32d4fef4ee910449e433943835aaec31b2ba2a 中，随本 PR 一并交接。接手 agent 应 checkout 本 PR 分支，先阅读 spec、plan 和基线提交，再按 Task 1–7 执行；Task 2、5、7 须整合已有补丁，不能覆盖或重复实现。无需访问原机器的 worktree 或未提交文件。

下文所有命令从仓库根目录运行。文档中的代码块是明确的实现片段或测试内容，按标注文件插入；现有文本、图片、OAuth 与路由逻辑继续保留。既有 helper 的引用会在 Interfaces 中标出；新 helper 均在所属任务定义。每个任务的提交前检查 git diff，仅暂存任务相关文件；若发现其他人新增的同文件修改，按 hunks 暂存。

| 任务 | 文件职责                                                            | 依赖     |
| ---- | ------------------------------------------------------------------- | -------- |
| 1    | query/approval 协议回复、必要 schema、协议错误类型、driver 测试夹具 | 当前基线 |
| 2    | MCP 调用身份、快照和最终输入；移出 interaction 的私有协作者         | 1        |
| 3    | 原子工具批次与可撤销交接                                            | 2        |
| 4    | 唯一终态、Connect/EOF 边界、阶段计时、取消清理                      | 3        |
| 5    | 结构化 root 历史、无 checkpoint 交接缓存、增量结果关联              | 2、3、4  |
| 6    | logger 注入、安全阶段诊断                                           | 4、5     |
| 7    | 真实 SDK/Responses 离线回归、检查、发布说明                         | 1–6      |

新增生产文件总表（相对仓库根）：

- packages/plugins/cursor/src/runtime/protocol-error.ts：协议错误，不设独立“只验证类字段”的低价值测试。
- packages/plugins/cursor/src/runtime/mcp-call.ts：共享只读完成调用类型。
- packages/plugins/cursor/src/runtime/interaction-query/{index.ts,interaction-query.ts}：query 回复入口与实现。
- packages/plugins/cursor/src/runtime/stream/interaction/{mcp-state.ts,mcp-input.ts}：仅供 interaction 目录内部使用。
- packages/plugins/cursor/src/runtime/driver/{lifecycle.ts,diagnostics.ts}：仅供 driver 内使用。
- packages/plugins/cursor/src/runtime/history/{root-messages.ts,tool-result.ts}：仅供 history 内使用。
- packages/plugins/cursor/src/runtime/cursor-model/test-support.ts：仅供测试使用的真实 Run/KV 双轮夹具。

新增测试在对应模块目录；driver/test-support.ts 是测试夹具。跨包端到端测试放在 core 的 cursor-regression 目录，不增加产品运行时依赖。index.ts 只导出，不放逻辑。

## Task 1: 回应交互请求并区分审批探测

**Files:**

- Modify: [agent.proto](../../../packages/plugins/cursor/src/gen/agent.proto#L859)、[agent_pb.ts](../../../packages/plugins/cursor/src/gen/agent_pb.ts#L8312)、[来源说明](../../../packages/plugins/cursor/src/gen/README.md)
- Create: packages/plugins/cursor/src/runtime/protocol-error.ts
- Create: packages/plugins/cursor/src/runtime/interaction-query/index.ts
- Create: packages/plugins/cursor/src/runtime/interaction-query/interaction-query.ts
- Create: packages/plugins/cursor/src/runtime/interaction-query/interaction-query.test.ts
- Modify: [client-messages.ts](../../../packages/plugins/cursor/src/runtime/client-messages/client-messages.ts#L46)、其 index.ts
- Modify: [driver.ts](../../../packages/plugins/cursor/src/runtime/driver/driver.ts#L82)、[interaction.ts](../../../packages/plugins/cursor/src/runtime/stream/interaction/interaction.ts#L35)
- Test: packages/plugins/cursor/src/runtime/driver/driver.test.ts
- Create: packages/plugins/cursor/src/runtime/driver/test-support.ts

**Interfaces:**

- Consumes: 现有 runCursorTurn(input)、CursorTransport.openRun、frameConnectMessage、AgentServerMessageSchema、AgentClientMessageSchema。
- Produces: encodeInteractionReply(query: InteractionQuery): Uint8Array，返回完整 Connect frame；不能表示的交互抛 CursorProtocolError。
- Produces: encodeMcpApprovalRejection(exec: ExecServerMessage): Uint8Array，保留 exec.id/execId。
- Produces: CursorProtocolError(code: CursorProtocolErrorCode, message: string)，code 枚举见下方代码。
- Produces: 测试辅助 runHarness(overrides?: Partial<Omit<Parameters<typeof runCursorTurn>[0], 'transport'>>, openGate?: Promise<void>)，返回真实 driver 的 stream/result、parts、drained、writes、send、eof、fail、cancel、closeCount。

- [ ] **Step 1: 建立可控真实帧夹具，并写回包/探测回归。**

driver/test-support.ts：

```ts
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
} from '../../gen/agent_pb';
import type { ConnectFrame } from '../../wire/frame';
import type { CursorTransport } from '../../wire/transport';
import { runCursorTurn } from './driver';

export const serverFrame = (message: Record<string, unknown>): ConnectFrame => ({
  flags: 0,
  payload: toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message } as never)),
});

export const updateFrame = (message: Record<string, unknown>) =>
  serverFrame({ case: 'interactionUpdate', value: { message } });

export async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

export function runHarness(
  overrides: Partial<Omit<Parameters<typeof runCursorTurn>[0], 'transport'>> = {},
  openGate?: Promise<void>,
) {
  const queue: ConnectFrame[] = [];
  const writes: ReturnType<typeof fromClient>[] = [];
  const parts: LanguageModelV4StreamPart[] = [];
  const trailers = Promise.withResolvers<Record<string, string>>();
  let closed = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  let closeCount = 0;
  const notify = () => {
    const next = wake;
    wake = undefined;
    next?.();
  };
  const transport: CursorTransport = {
    unary: async () => {
      throw new Error('unused unary');
    },
    openRun: async () => {
      if (openGate !== undefined) await openGate;
      return {
        write: (bytes) => {
          writes.push(fromClient(bytes));
        },
        end: () => {},
        close: () => {
          closeCount++;
          closed = true;
          trailers.resolve({});
          notify();
        },
        trailers: trailers.promise,
        frames: (async function* () {
          for (;;) {
            if (failure !== undefined) throw failure;
            const frame = queue.shift();
            if (frame !== undefined) {
              yield frame;
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
      };
    },
  };
  const turn = runCursorTurn({
    transport,
    accessToken: 'test-token',
    requestBytes: toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, {})),
    initialConversationState: create(ConversationStateStructureSchema, {}),
    requestContextTools: [],
    blobStore: new Map(),
    heartbeatMs: 0,
    ...overrides,
  });
  const reader = turn.stream.getReader();
  const drained = (async () => {
    for (;;) {
      const item = await reader.read();
      if (item.done) return parts;
      parts.push(item.value);
    }
  })();
  void drained.catch(() => {});
  void turn.result.catch(() => {});
  return {
    ...turn,
    writes,
    parts,
    drained,
    send(frame: ConnectFrame) {
      queue.push(frame);
      notify();
    },
    eof(values: Record<string, string> = {}) {
      trailers.resolve(values);
      closed = true;
      notify();
    },
    fail(error: unknown) {
      failure = error;
      closed = true;
      trailers.resolve({});
      notify();
    },
    cancel: (reason?: unknown) => reader.cancel(reason),
    closeCount: () => closeCount,
  };
}

function fromClient(bytes: Uint8Array) {
  return fromBinary(AgentClientMessageSchema, bytes.subarray(5)).message;
}
```

在 driver.test.ts 引入夹具，以及 fromBinary/toBinary/McpArgsSchema，加入以下测试。原有测试保留：

```ts
test('replies to a hosted search query with its original id', async () => {
  const h = runHarness();
  h.send(
    serverFrame({
      case: 'interactionQuery',
      value: {
        id: 41,
        query: { case: 'webSearchRequestQuery', value: {} },
      },
    }),
  );
  await settleMicrotasks();
  expect(h.writes).toContainEqual(
    expect.objectContaining({
      case: 'interactionResponse',
      value: expect.objectContaining({
        id: 41,
        result: expect.objectContaining({ case: 'webSearchRequestResponse' }),
      }),
    }),
  );
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  h.eof();
  await h.drained;
  await h.result;
});

test('an approval-only wire frame never becomes an executable call', async () => {
  const base = toBinary(
    McpArgsSchema,
    create(McpArgsSchema, {
      name: 'search',
      toolName: 'search',
      toolCallId: 'probe',
      args: { query: new TextEncoder().encode('"docs"') },
    }),
  );
  const bytes = new Uint8Array([...base, 0x38, 0x01]);
  const h = runHarness();
  h.send(
    serverFrame({
      case: 'execServerMessage',
      value: {
        id: 7,
        execId: 'exec-7',
        message: { case: 'mcpArgs', value: fromBinary(McpArgsSchema, bytes) },
      },
    }),
  );
  await settleMicrotasks();
  expect(h.parts.some((part) => part.type.startsWith('tool-'))).toBe(false);
  expect(h.writes).toContainEqual(
    expect.objectContaining({
      case: 'execClientMessage',
      value: expect.objectContaining({
        id: 7,
        execId: 'exec-7',
        message: expect.objectContaining({
          case: 'mcpResult',
          value: expect.objectContaining({ result: expect.objectContaining({ case: 'rejected' }) }),
        }),
      }),
    }),
  );
  h.send(
    serverFrame({
      case: 'execServerMessage',
      value: {
        id: 7,
        execId: 'exec-7',
        message: { case: 'mcpArgs', value: fromBinary(McpArgsSchema, base) },
      },
    }),
  );
  await h.drained;
  await h.result;
  expect(h.parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
});

test('unknown queries fail instead of leaving upstream waiting', async () => {
  const h = runHarness();
  h.send(serverFrame({ case: 'interactionQuery', value: { id: 9 } }));
  await expect(h.result).rejects.toMatchObject({ code: 'cursor_interaction_unsupported' });
  expect(h.closeCount()).toBe(1);
});
```

interaction-query.test.ts 使用以下完整表驱动测试；导入 bun:test、protobuf create/fromBinary、AgentClientMessageSchema、InteractionQuerySchema 和 encodeInteractionReply：

```ts
test.each([
  ['webSearchRequestQuery', 'webSearchRequestResponse', 'approved'],
  ['exaSearchRequestQuery', 'exaSearchRequestResponse', 'approved'],
  ['exaFetchRequestQuery', 'exaFetchRequestResponse', 'approved'],
  ['webFetchRequestQuery', 'webFetchRequestResponse', 'approved'],
  ['askQuestionInteractionQuery', 'askQuestionInteractionResponse', 'rejected'],
  ['switchModeRequestQuery', 'switchModeRequestResponse', 'rejected'],
  ['createPlanRequestQuery', 'createPlanRequestResponse', 'error'],
] as const)('%s sends an explicit %s %s reply', (queryCase, responseCase, outcome) => {
  const query = create(InteractionQuerySchema, { id: 41, query: { case: queryCase, value: {} } } as never);
  const decoded = fromBinary(AgentClientMessageSchema, encodeInteractionReply(query).subarray(5));
  expect(decoded.message.case).toBe('interactionResponse');
  if (decoded.message.case !== 'interactionResponse') throw new Error('expected interaction response');
  const response = decoded.message.value;
  expect(response.id).toBe(41);
  expect(response.result.case).toBe(responseCase);
  const value = response.result.value as { result?: { case?: string; result?: { case?: string } } };
  const nested = value.result;
  expect(nested?.case ?? nested?.result?.case).toBe(outcome);
  expect(JSON.stringify(response)).not.toContain('"case":"success"');
});

test.each(['setupVmEnvironmentArgs', undefined] as const)('fails unsupported query %s', (queryCase) => {
  const query = create(InteractionQuerySchema, {
    id: 9,
    ...(queryCase === undefined ? {} : { query: { case: queryCase, value: {} } }),
  } as never);
  expect(() => encodeInteractionReply(query)).toThrow(
    expect.objectContaining({
      code: 'cursor_interaction_unsupported',
    }),
  );
});
```

- [ ] **Step 2: 运行新回归并记录预期失败。**

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/driver/driver.test.ts -t 'replies to a hosted|approval-only wire|unknown queries'
```

预期：query 缺回复；approval probe 出现 tool-call；unknown query 测试超时。它们证明产品缺口，不接受仅因导入缺失造成的失败作为证据。

- [ ] **Step 3: 扩展必需 schema 并生成。**

在 McpArgs 增加 bool smart_mode_approval_only = 7；在 InteractionQuery/InteractionResponse 分别增加下面的第 9 字段。字段 6 未使用，保持 unknown-field 兼容，不虚构定义。

```proto
WebFetchRequestQuery web_fetch_request_query = 9;
WebFetchRequestResponse web_fetch_request_response = 9;

message WebFetchRequestQuery { FetchArgs args = 1; }
message WebFetchRequestResponse {
  oneof result {
    WebFetchRequestResponse_Approved approved = 1;
    WebFetchRequestResponse_Rejected rejected = 2;
  }
}
message WebFetchRequestResponse_Approved {}
message WebFetchRequestResponse_Rejected { string reason = 1; }
```

将两个字段插入各自 oneof，消息定义放在 query 相关消息旁；不是把字段放到顶层。先核对固定 OMP 源码：

```sh
rtk proxy git -C .reference/oh-my-pi show 3e181fe0cb73f8fbc8b5654335dee08177e2417b:packages/ai/src/providers/cursor/proto/agent.proto
```

按 gen/README.md 使用 protoc-gen-es 2.10.2。若工具未安装，安装到临时工具目录，不修改 workspace 依赖：

```sh
rtk proxy mkdir -p /tmp/aio-cursor-protoc-tools
rtk proxy bun add --cwd /tmp/aio-cursor-protoc-tools @bufbuild/protoc-gen-es@2.10.2 @bufbuild/buf@1.57.2
```

创建临时 buf.gen.yaml，内容如下；local 的可执行文件路径固定指向上述工具目录：

```yaml
version: v2
plugins:
  - local: /tmp/aio-cursor-protoc-tools/node_modules/.bin/protoc-gen-es
    out: packages/plugins/cursor/src/gen
    opt:
      - target=ts
inputs:
  - directory: packages/plugins/cursor/src/gen
```

运行：

```sh
rtk proxy /tmp/aio-cursor-protoc-tools/node_modules/.bin/buf generate --template /tmp/aio-cursor-protoc-tools/buf.gen.yaml --path agent.proto
```

保留生成 banner，恢复 // Source: agent.proto (see ./README.md for provenance)。确认 turns_old 的 @deprecated 注释仍附在旧字段上。README 保留原 vendor 基线，新增这两项已核对补丁和来源提交；不把来源改写为整份来自新提交。aiserver 生成物不应改变。

- [ ] **Step 4: 实现协议回复并接入 driver。**

protocol-error.ts：

```ts
export type CursorProtocolErrorCode =
  | 'cursor_interaction_unsupported'
  | 'cursor_tool_input_incomplete'
  | 'cursor_tool_input_invalid'
  | 'cursor_tool_identity_conflict'
  | 'cursor_stream_incomplete'
  | 'cursor_first_frame_timeout'
  | 'cursor_frame_silence_timeout'
  | 'cursor_no_progress_timeout';

export class CursorProtocolError extends Error {
  readonly code: CursorProtocolErrorCode;
  constructor(code: CursorProtocolErrorCode, message: string) {
    super(message);
    this.name = 'CursorProtocolError';
    this.code = code;
  }
}
```

interaction-query.ts 的函数用以下确定的返回内容。各分支调用 create(InteractionResponseSchema, ...)；嵌套对象由 protobuf create 初始化。encoded helper 只做现有 framing：

```ts
const NON_INTERACTIVE = 'This proxy cannot perform this client interaction.';
const NO_FILES = 'This proxy cannot create plan files.';

export function encodeInteractionReply(query: InteractionQuery): Uint8Array {
  const id = query.id;
  switch (query.query.case) {
    case 'webSearchRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'webSearchRequestResponse',
            value: { result: { case: 'approved', value: {} } },
          },
        }),
      );
    case 'exaSearchRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'exaSearchRequestResponse',
            value: { result: { case: 'approved', value: {} } },
          },
        }),
      );
    case 'exaFetchRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'exaFetchRequestResponse',
            value: { result: { case: 'approved', value: {} } },
          },
        }),
      );
    case 'webFetchRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'webFetchRequestResponse',
            value: { result: { case: 'approved', value: {} } },
          },
        }),
      );
    case 'askQuestionInteractionQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'askQuestionInteractionResponse',
            value: { result: { result: { case: 'rejected', value: { reason: NON_INTERACTIVE } } } },
          },
        }),
      );
    case 'switchModeRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'switchModeRequestResponse',
            value: { result: { case: 'rejected', value: { reason: NON_INTERACTIVE } } },
          },
        }),
      );
    case 'createPlanRequestQuery':
      return encoded(
        create(InteractionResponseSchema, {
          id,
          result: {
            case: 'createPlanRequestResponse',
            value: { result: { result: { case: 'error', value: { error: NO_FILES } } } },
          },
        }),
      );
    default:
      throw new CursorProtocolError('cursor_interaction_unsupported', NON_INTERACTIVE);
  }
}

function encoded(response: InteractionResponse): Uint8Array {
  return frameConnectMessage(
    toBinary(
      AgentClientMessageSchema,
      create(AgentClientMessageSchema, {
        message: { case: 'interactionResponse', value: response },
      }),
    ),
  );
}
```

导入 create/toBinary、InteractionQuery/InteractionResponse 类型和两个 schema、frameConnectMessage、CursorProtocolError；index.ts 仅导出 encodeInteractionReply。

client-messages.ts 新增 encodeMcpApprovalRejection，复用该文件已有私有 frame 函数：

```ts
export function encodeMcpApprovalRejection(exec: ExecServerMessage): Uint8Array {
  return frame({
    case: 'execClientMessage',
    value: create(ExecClientMessageSchema, {
      id: exec.id,
      execId: exec.execId,
      message: {
        case: 'mcpResult',
        value: create(McpResultSchema, {
          result: {
            case: 'rejected',
            value: create(McpRejectedSchema, {
              reason: 'Tool approval is owned by the external client.',
            }),
          },
        }),
      },
    }),
  });
}
```

driver 加 interactionQuery 分支调用 h2.write(encodeInteractionReply(...))；在 mcpArgs 路径先判断 smartModeApprovalOnly，true 只写拒绝，false 才进 mapper。interaction mapper 同样在携带该标志的 MCP 展示帧上返回 []，禁止建立工具状态。普通真实 MCP 的去重状态不受探测污染。

- [ ] **Step 5: 验证完整行为矩阵，提交本任务。**

把 Step 1 的审批探测扩展为“probe → 同 ID 真调用”，确认前者 0 次、后者 1 次 executable call；给嵌入 interaction 的 probe 同样验证。query 表八种行为均解码检查。

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/interaction-query packages/plugins/cursor/src/runtime/client-messages packages/plugins/cursor/src/runtime/driver
rtk proxy bun run --cwd packages/plugins/cursor test:unit
rtk proxy git diff --check
```

预期相关回归与现有测试通过。仅暂存已核对的任务文件：

```sh
rtk proxy git add packages/plugins/cursor/src/gen/agent.proto packages/plugins/cursor/src/gen/agent_pb.ts packages/plugins/cursor/src/gen/README.md packages/plugins/cursor/src/runtime/protocol-error.ts packages/plugins/cursor/src/runtime/interaction-query packages/plugins/cursor/src/runtime/client-messages packages/plugins/cursor/src/runtime/driver packages/plugins/cursor/src/runtime/stream/interaction/interaction.ts
rtk proxy git commit -m "fix(cursor): reply to interaction queries and approval probes" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 2: 保留乱序参数并确定工具输入

**Files:**

- Create: packages/plugins/cursor/src/runtime/mcp-call.ts
- Create: packages/plugins/cursor/src/runtime/stream/interaction/mcp-input.ts
- Create: packages/plugins/cursor/src/runtime/stream/interaction/mcp-state.ts
- Modify: [interaction.ts](../../../packages/plugins/cursor/src/runtime/stream/interaction/interaction.ts)、该目录 index.ts、runtime/stream/index.ts
- Modify: [driver.ts](../../../packages/plugins/cursor/src/runtime/driver/driver.ts)
- Test: packages/plugins/cursor/src/runtime/stream/interaction/interaction.test.ts
- Test: packages/plugins/cursor/src/runtime/driver/driver.test.ts

**Interfaces:**

- Consumes: Task 1 CursorProtocolError、McpArgs.smartModeApprovalOnly；已有 fromWireName、decodeMcpArgValue 规则和参数合并补丁。
- Produces: CursorCompletedToolCall 类型，与 spec 完全一致。
- Produces: createCursorStreamAccumulator(tools?: readonly McpToolDefinition[]): CursorStreamAccumulator。
- Produces: cursorToolState(accumulator): { openCount: number; readyCount: number; revision: number; progressRevision: number }。
- Produces: cursorCompletedTools(accumulator): readonly CursorCompletedToolCall[]，返回 ready 调用的只读快照。
- Produces: commitCursorTools(accumulator): LanguageModelV4StreamPart[]，仅第一次调用产生工具 parts。
- Preserves: mapInteractionUpdate(update, accumulator)、mapMcpExec(mcp, accumulator)、finalizeCursorStream(accumulator) 的函数签名；MCP 映射阶段只收集状态，工具 parts 由 commitCursorTools 生成。
- Private: updateMcp(state, event, outerId, args, snapshot?)，event 为 start/partial/complete/exec；只由 interaction.ts 调用。

- [ ] **Step 1: 为早到快照和迟到 exec 参数写失败测试。**

在 interaction.test.ts 导入 mapMcpExec、cursorToolState、cursorCompletedTools、commitCursorTools 和 McpArgsSchema。保留现有 update/argValue 夹具，增加：

```ts
const mcp = (input: Record<string, Uint8Array> = {}) =>
  create(McpArgsSchema, {
    name: 'search',
    toolName: 'search',
    toolCallId: 'nested',
    args: input,
  });
const mcpUpdate = (
  event: 'toolCallStarted' | 'partialToolCall' | 'toolCallCompleted',
  args: ReturnType<typeof mcp>,
  argsTextDelta?: string,
) =>
  update({
    case: event,
    value: {
      callId: 'outer',
      ...(argsTextDelta === undefined ? {} : { argsTextDelta }),
      toolCall: { tool: { case: 'mcpToolCall', value: { args } } },
    },
  });

test('a snapshot before started survives repeated started and a partial final map', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), '{"query":"docs","limit":6}'), a);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
  const parts = commitCursorTools(a);
  expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
    toolCallId: 'outer',
    input: '{"query":"docs","limit":6}',
  });
  expect(parts.filter((p) => p.type === 'tool-input-delta')).toHaveLength(1);
});

test('an empty completion waits for later authoritative exec args', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp()), a);
  expect(cursorToolState(a)).toMatchObject({ openCount: 1, readyCount: 0 });
  expect(commitCursorTools(a)).toEqual([]);
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  const parts = commitCursorTools(a);
  expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({ input: '{"query":"docs"}' });
  expect(commitCursorTools(a)).toEqual([]);
});

test.each(['{"query":', '[]', '"scalar"'])(
  'never converts incomplete/invalid input %s to an executable empty object',
  (text) => {
    const a = createCursorStreamAccumulator();
    mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), text), a);
    mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp()), a);
    expect(commitCursorTools(a)).toEqual([]);
    expect(cursorToolState(a).openCount).toBe(1);
  },
);
```

对既有参数流矩阵，在所有输入事件之后显式追加 commitCursorTools 的输出，再断言 delta/final 一致。原有“空 completion 立即等于 {}”测试要改为提供明确无参数的声明，或提供空 exec；不能删掉无参数工具支持。

- [ ] **Step 2: 跑失败用例，确认旧逻辑丢字段或过早完成。**

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/stream/interaction -t 'snapshot before|empty completion waits|never converts'
```

在新公共 helper 尚未实现时导入失败仅是编译阶段；先将 cursorToolState/commitCursorTools 接到旧 accumulator 的对应集合，再确认断言实际暴露丢字段和提前输出问题，随后进行归约器改动。不要把“找不到 export”记录为行为复现。

- [ ] **Step 3: 提取参数规则和共享完成记录。**

mcp-call.ts：

```ts
export type CursorCompletedToolCall = {
  readonly outerCallId: string;
  readonly nestedToolCallId: string;
  readonly toolName: string;
  readonly input: string;
};
```

mcp-input.ts 移入现有 decodeMcpArgValue/decodeMcpArgsMap（保留 protobuf Value 与原始 JSON bytes 的双解码路径），加入以下规则：

```ts
export function appendMcpSnapshot(buffer: string, snapshot: string): string {
  if (!snapshot || buffer.startsWith(snapshot)) return buffer;
  return snapshot.startsWith(buffer) ? snapshot : buffer + snapshot;
}

export function parseMcpObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function mergeMcpObjects(
  prior: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = { ...prior };
  for (const [key, value] of Object.entries(next ?? {})) {
    const previous = merged[key];
    if (typeof value === 'string' && (isPlainObject(previous) || Array.isArray(previous))) continue;
    merged[key] = value;
  }
  return merged;
}

export function declaresNoArguments(schema: unknown): boolean {
  if (!isPlainObject(schema) || schema.type !== 'object') return false;
  if (!isPlainObject(schema.properties) || Object.keys(schema.properties).length !== 0) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) return false;
  return !['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'dependentRequired', 'dependentSchemas'].some(
    (key) => key in schema,
  );
}
```

导入 isPlainObject。工具 schema 从 McpToolDefinition.inputSchema 用现有 ValueSchema/fromBinary/toJson 解码，解码失败只代表不能确认无参数，不报假成功。

- [ ] **Step 4: 实现按身份归约的 MCP 状态，替换原 start/delta/complete。**

mcp-state.ts 使用下述状态；所有 Map 生命周期限定在一个 Run：

```ts
type McpCall = {
  outerCallId: string;
  outerBound?: string;
  nestedToolCallId: string;
  toolName: string;
  buffer: string;
  completion?: Record<string, unknown>;
  exec?: Record<string, unknown>;
  sawCompletion: boolean;
  sawExec: boolean;
  allowsEmpty: boolean;
  input?: string;
};

export type McpState = {
  calls: Map<string, McpCall>;
  outerAliases: Map<string, string>;
  nestedAliases: Map<string, string>;
  earlySnapshots: Map<string, string>;
  emptyTools: Set<string>;
  revision: number;
  progressRevision: number;
  committed: boolean;
};
```

createMcpState/readReadyMcpCalls/readMcpState 与身份归约入口放在 mcp-state.ts。给 McpCall 增加 outerBound?: string，区分“外层 ID 已绑定”与 exec-first 的公开 ID 暂定值。导入 fromBinary/toJson、ValueSchema、McpToolDefinition/McpArgs、fromWireName、CursorProtocolError 和 Task 2 参数函数：

```ts
export function createMcpState(tools: readonly McpToolDefinition[]): McpState {
  const emptyTools = new Set<string>();
  for (const tool of tools) {
    try {
      if (declaresNoArguments(toJson(ValueSchema, fromBinary(ValueSchema, tool.inputSchema)))) {
        emptyTools.add(fromWireName(tool.name));
      }
    } catch {
      /* An unreadable declaration is not proof of empty input. */
    }
  }
  return {
    calls: new Map(),
    outerAliases: new Map(),
    nestedAliases: new Map(),
    earlySnapshots: new Map(),
    emptyTools,
    revision: 0,
    progressRevision: 0,
    committed: false,
  };
}

export function readReadyMcpCalls(state: McpState): readonly CursorCompletedToolCall[] {
  const ready: CursorCompletedToolCall[] = [];
  for (const call of state.calls.values()) {
    if (call.input === undefined) continue;
    ready.push({
      outerCallId: call.outerCallId,
      nestedToolCallId: call.nestedToolCallId,
      toolName: call.toolName,
      input: call.input,
    });
  }
  return ready;
}

export function readMcpState(state: McpState) {
  const readyCount = readReadyMcpCalls(state).length;
  return {
    openCount: state.calls.size - readyCount,
    readyCount,
    revision: state.revision,
    progressRevision: state.progressRevision,
  };
}

export function updateMcp(
  state: McpState,
  event: 'start' | 'partial' | 'complete' | 'exec',
  outerId: string | undefined,
  args: McpArgs | undefined,
  snapshot?: string,
): void {
  if (state.committed || args?.smartModeApprovalOnly) return;
  const outer = outerId || undefined;
  const nested = args?.toolCallId || undefined;
  const name = args === undefined ? undefined : fromWireName(args.toolName || args.name) || undefined;
  const byOuter = outer === undefined ? undefined : state.outerAliases.get(outer);
  const byNested = nested === undefined ? undefined : state.nestedAliases.get(nested);
  const conflict = () => new CursorProtocolError('cursor_tool_identity_conflict', 'Cursor MCP identity conflicts.');
  if (byOuter !== undefined && byNested !== undefined && byOuter !== byNested) throw conflict();
  let key = byOuter ?? byNested;
  if (key === undefined && args === undefined) {
    if (outer !== undefined && snapshot !== undefined) {
      state.earlySnapshots.set(outer, appendMcpSnapshot(state.earlySnapshots.get(outer) ?? '', snapshot));
    }
    return;
  }
  if (key === undefined && ((outer === undefined && nested === undefined) || name === undefined)) throw conflict();
  key ??= outer === undefined ? 'nested:' + nested : 'outer:' + outer;
  let call = state.calls.get(key);
  const before = call === undefined ? undefined : JSON.stringify(call);
  if (call === undefined) {
    call = {
      outerCallId: outer ?? nested!,
      ...(outer === undefined ? {} : { outerBound: outer }),
      nestedToolCallId: nested ?? '',
      toolName: name!,
      buffer: '',
      sawCompletion: false,
      sawExec: false,
      allowsEmpty: state.emptyTools.has(name!),
    };
    state.calls.set(key, call);
  }
  if (outer !== undefined && call.outerBound !== undefined && call.outerBound !== outer) throw conflict();
  if (nested !== undefined && call.nestedToolCallId && call.nestedToolCallId !== nested) throw conflict();
  if (name !== undefined && call.toolName !== name) throw conflict();
  if (outer !== undefined) {
    call.outerBound = outer;
    call.outerCallId = outer;
    state.outerAliases.set(outer, key);
    call.buffer = appendMcpSnapshot(call.buffer, state.earlySnapshots.get(outer) ?? '');
    state.earlySnapshots.delete(outer);
  }
  if (nested !== undefined) {
    call.nestedToolCallId = nested;
    state.nestedAliases.set(nested, key);
  }
  applyMcpEvent(call, event, args, snapshot);
  if (!call.nestedToolCallId) call.input = undefined;
  if (before !== JSON.stringify(call)) {
    state.revision++;
    state.progressRevision++;
  }
}
```

canonical 内部键含命名空间，创建后不更名；公开 ID 在交接前可从 nested 升级为已观察到的 outer。缺少 nested ID 的展示记录继续等待，不能伪造用于续接的 nested ID；终止边界按不完整输入失败。现有同 ID/不同名称、双索引冲突均在交接前失败。

归约器 applyMcpEvent 的就绪规则如下：

```ts
// applyMcpEvent(call: McpCall, event: 'start' | 'partial' | 'complete' | 'exec',
//               args: McpArgs | undefined, snapshot: string | undefined): void
function applyMcpEvent(
  call: McpCall,
  event: 'start' | 'partial' | 'complete' | 'exec',
  args: McpArgs | undefined,
  snapshot: string | undefined,
): void {
  if (snapshot !== undefined) call.buffer = appendMcpSnapshot(call.buffer, snapshot);
  const decoded = args === undefined ? undefined : decodeMcpArgsMap(args.args);
  if (event === 'complete') {
    call.sawCompletion = true;
    call.completion = mergeMcpObjects(call.completion, decoded);
  }
  if (event === 'exec') {
    call.sawExec = true;
    call.exec = mergeMcpObjects(call.exec, decoded);
  }
  const buffered = parseMcpObject(call.buffer);
  const hasFinalFields = Object.keys(call.completion ?? {}).length > 0 || Object.keys(call.exec ?? {}).length > 0;
  const hasBadSnapshot = call.buffer.trim().length > 0 && buffered === undefined;
  const explicitEmpty =
    call.sawExec || buffered !== undefined || (call.sawCompletion && call.allowsEmpty && !hasBadSnapshot);
  if ((!call.sawCompletion && !call.sawExec) || (!hasFinalFields && !explicitEmpty)) {
    call.input = undefined;
    return;
  }
  call.input = JSON.stringify(mergeMcpObjects(mergeMcpObjects(buffered, call.completion), call.exec));
}
```

非法/不完整非空 buffer 且没有有效完成/exec 信息时仍为未就绪。buffer 非空但不是 JSON object 的情况下，hasBadSnapshot 禁止单凭 allowsEmpty 放行。有效的权威 map 可以修复不完整 buffer，不能因为曾有半截快照就拒绝完整调用。

updateMcp 先过滤 approval-only；没有 args 且找不到既有 MCP 身份的 partial 仅缓存 earlySnapshots；没有身份的普通 complete 不合成调用。effective buffer/final map/input/identity 的变化才增加 revision 与 progressRevision；完全重复事件幂等，不延长交接窗口。工具身份新建算一次有效变化。这里不输出任何 tool parts。

interaction.ts 分派 started/partial/completed 到 updateMcp；mapMcpExec 分派 exec；native toolCallDelta 维持内部事件处理，不假装 MCP 参数。文本与 thinking 原函数不变。

commitCursorTools 的实现留在 interaction.ts，使用已有 closeText/closeReasoning；对应 private state helpers 仅在此目录导入：

```ts
export function commitCursorTools(a: CursorStreamAccumulator): LanguageModelV4StreamPart[] {
  const state = cursorToolState(a);
  if (a.mcp.committed || state.openCount > 0 || state.readyCount === 0) return [];
  a.mcp.committed = true;
  const parts: LanguageModelV4StreamPart[] = [...closeText(a), ...closeReasoning(a)];
  for (const call of cursorCompletedTools(a)) {
    parts.push(
      { type: 'tool-input-start', id: call.outerCallId, toolName: call.toolName },
      { type: 'tool-input-delta', id: call.outerCallId, delta: call.input },
      { type: 'tool-input-end', id: call.outerCallId },
      { type: 'tool-call', toolCallId: call.outerCallId, toolName: call.toolName, input: call.input },
    );
    a.toolCalls++;
  }
  return parts;
}
```

给 accumulator 增加 mcp: McpState；旧 tools/completedToolCalls 访问全部替换为公共只读 helper。Task 2 暂在 driver 原来的交接位置调用 commitCursorTools，再 finalize；从 cursorCompletedTools 派生原 pending Map。这样本任务可独立通过测试，Task 3 再改变交接时间。

- [ ] **Step 5: 验证身份与无参数分支，提交。**

在同一 interaction.test.ts 增加以下参数化场景，复用上方 mcpUpdate：

```ts
test.each([
  ['exec empty', true, false],
  ['declared no-arg completion', false, true],
] as const)('preserves legitimate empty input: %s', (_label, execEmpty, declaredEmpty) => {
  const tools = declaredEmpty
    ? buildMcpToolDefinitions([
        {
          type: 'function',
          name: 'search',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ])
    : [];
  const a = createCursorStreamAccumulator(tools);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  if (execEmpty) mapMcpExec(mcp(), a);
  else mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp()), a);
  expect(commitCursorTools(a).find((p) => p.type === 'tool-call')).toMatchObject({ input: '{}' });
});
```

补充真实调用身份的行为断言；复用本任务定义的 mcp/mcpUpdate：

```ts
test('exec-first aliases upgrade to the observed outer id before commit', () => {
  const a = createCursorStreamAccumulator();
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(update({ case: 'toolCallCompleted', value: { callId: 'outer' } }), a);
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  const calls = commitCursorTools(a).filter((p) => p.type === 'tool-call');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ toolCallId: 'outer', input: '{"query":"docs"}' });
  expect(cursorCompletedTools(a)).toMatchObject([{ outerCallId: 'outer', nestedToolCallId: 'nested' }]);
});

test('a reused identity with a different name fails before emitting tools', () => {
  const a = createCursorStreamAccumulator();
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  expect(() =>
    mapMcpExec(
      create(McpArgsSchema, {
        ...mcp(),
        toolName: 'other',
        name: 'other',
      }),
      a,
    ),
  ).toThrow(expect.objectContaining({ code: 'cursor_tool_identity_conflict' }));
});

test('a call-id-only early snapshot joins its later MCP identity', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(
    update({
      case: 'partialToolCall',
      value: {
        callId: 'outer',
        argsTextDelta: '{"query":"docs","limit":6}',
      },
    }),
    a,
  );
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
  expect(commitCursorTools(a).find((p) => p.type === 'tool-call')).toMatchObject({
    toolCallId: 'outer',
    input: '{"query":"docs","limit":6}',
  });
});
```

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/stream/interaction packages/plugins/cursor/src/runtime/driver
rtk proxy bun run --cwd packages/plugins/cursor test:unit
rtk proxy git diff --check
rtk proxy git add packages/plugins/cursor/src/runtime/mcp-call.ts packages/plugins/cursor/src/runtime/stream packages/plugins/cursor/src/runtime/driver/driver.ts packages/plugins/cursor/src/runtime/driver/driver.test.ts
rtk proxy git commit -m "fix(cursor): preserve MCP arguments across event ordering" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 3: 原子交接完整工具批次

**Files:**

- Modify: [driver.ts](../../../packages/plugins/cursor/src/runtime/driver/driver.ts)
- Test: packages/plugins/cursor/src/runtime/driver/driver.test.ts
- Reuse: packages/plugins/cursor/src/runtime/driver/test-support.ts

**Interfaces:**

- Consumes: cursorToolState(a)、cursorCompletedTools(a)、commitCursorTools(a)，签名见 Task 2。
- Produces: CursorTurnResult 新增 assistantText: string、toolCalls: readonly CursorCompletedToolCall[]；pendingToolCalls 保持 Map<string,string>。
- Produces: driver 输入 timing?: Partial<CursorRunTiming>；CursorRunTiming 的全部字段为 spec 的五个内部计时字段（heartbeat 仍用原 heartbeatMs，不重复放 timing）。
- Internal: finishToolHandoff(): void，单点输出 batch、finish 并结算；后续由 Task 4 统一终态拥有者接管。

- [ ] **Step 1: 写可撤销窗口的真实 driver 测试。**

在 driver.test.ts 加入 jest/afterEach，用 afterEach 恢复 real timers。新 helper 只生成测试帧：

```ts
const execFrame = (id: string, query: string) =>
  serverFrame({
    case: 'execServerMessage',
    value: {
      id: id === 'a' ? 1 : 2,
      execId: 'exec-' + id,
      message: {
        case: 'mcpArgs',
        value: {
          name: 'search',
          toolName: 'search',
          toolCallId: id,
          args: { query: new TextEncoder().encode(JSON.stringify(query)) },
        },
      },
    },
  });

test('a late sibling revokes tool handoff until its own args are ready', async () => {
  jest.useFakeTimers();
  const h = runHarness({ timing: { toolHandoffGraceMs: 100 } });
  h.send(execFrame('a', 'alpha'));
  await settleMicrotasks();
  jest.advanceTimersByTime(90);
  h.send(
    updateFrame({
      case: 'toolCallStarted',
      value: {
        callId: 'outer-b',
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: { name: 'search', toolName: 'search', toolCallId: 'b', args: {} },
            },
          },
        },
      },
    }),
  );
  await settleMicrotasks();
  jest.advanceTimersByTime(20);
  await settleMicrotasks();
  expect(h.parts.some((p) => p.type === 'tool-call')).toBe(false);
  h.send(execFrame('b', 'beta'));
  await settleMicrotasks();
  jest.advanceTimersByTime(100);
  await h.drained;
  const calls = h.parts.filter((p) => p.type === 'tool-call');
  expect(calls).toMatchObject([
    { toolCallId: 'a', input: '{"query":"alpha"}' },
    { toolCallId: 'outer-b', input: '{"query":"beta"}' },
  ]);
  expect(h.parts.filter((p) => p.type === 'finish')).toHaveLength(1);
  expect(h.writes.filter((m) => m.case === 'execClientMessage')).toHaveLength(0);
  expect((await h.result).toolCalls).toHaveLength(2);
});
```

再用同一夹具覆盖 R2 和重复帧不续期：

```ts
test('consecutive MCP execs are handed off together', async () => {
  jest.useFakeTimers();
  const h = runHarness();
  h.send(execFrame('a', 'alpha'));
  h.send(execFrame('b', 'beta'));
  await settleMicrotasks();
  jest.advanceTimersByTime(100);
  await h.drained;
  expect(h.parts.filter((p) => p.type === 'tool-call')).toMatchObject([
    { toolCallId: 'a', input: '{"query":"alpha"}' },
    { toolCallId: 'b', input: '{"query":"beta"}' },
  ]);
});

test('duplicate exec does not extend the original handoff deadline', async () => {
  jest.useFakeTimers();
  const h = runHarness();
  h.send(execFrame('a', 'alpha'));
  await settleMicrotasks();
  jest.advanceTimersByTime(90);
  h.send(execFrame('a', 'alpha'));
  await settleMicrotasks();
  jest.advanceTimersByTime(10);
  await h.drained;
  expect(h.parts.filter((p) => p.type === 'tool-call')).toHaveLength(1);
});
```

- [ ] **Step 2: 先运行测试，确认即时收尾导致漏调用。**

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/driver -t 'late sibling|consecutive|duplicate exec'
```

预期旧交接逻辑已经输出 a/关闭，无法收到 b；记录这项行为失败。

- [ ] **Step 3: 用可撤销定时器替换立即 return。**

timing 类型定义在 driver.ts（公开输入类型）；lifecycle 私有文件稍后只消费内部数值，不把其类型从 barrel 暴露：

```ts
export type CursorRunTiming = {
  firstFrameTimeoutMs: number;
  frameSilenceTimeoutMs: number;
  noProgressTimeoutMs: number;
  toolHandoffGraceMs: number;
  turnEndGraceMs: number;
};
```

工具活动以 reducer 的 revision 变化为准。下面函数置于每个 run 的闭包，所有 timer 在 finally/cancel 清除：

```ts
let handoffTimer: ReturnType<typeof setTimeout> | undefined;
let lastToolRevision = 0;
const clearHandoff = () => {
  if (handoffTimer !== undefined) clearTimeout(handoffTimer);
  handoffTimer = undefined;
};
const updateHandoff = () => {
  const current = cursorToolState(accumulator);
  if (current.revision === lastToolRevision) return;
  lastToolRevision = current.revision;
  clearHandoff();
  if (current.openCount > 0 || current.readyCount === 0) return;
  handoffTimer = setTimeout(() => {
    handoffTimer = undefined;
    const latest = cursorToolState(accumulator);
    if (latest.openCount === 0 && latest.readyCount > 0) finishToolHandoff();
  }, input.timing?.toolHandoffGraceMs ?? 100);
};
```

finishToolHandoff 获取同一份 cursorCompletedTools；输出 commitCursorTools、finalizeCursorStream；用 new Map(calls.map(call => [call.outerCallId, call.nestedToolCallId])) 构造 pending。result.toolCalls 为 calls，assistantText 从本轮有效 textDelta 按顺序累积，不能包括 thinking。

新增本轮终态布尔值，timer 设置终态后 h2.close() 使阻塞的 frame iterator 醒来；for-await 发现终态立即退出，不走 EOF 成功/失败的第二次结算。实际连接 close 不应被“等待下一帧后才调用”的流程阻塞。Task 4 将该机制整理为唯一拥有者。

- [ ] **Step 4: 检查工具四元事件与无 fake result，并运行插件测试。**

断言每个调用对应的 start/delta/end/tool-call 连续且 ID 一致；两个不同输入不能串到同一 delta；delta 恰好一次。调整旧 100 ms 实时时间测试为 jest 假时钟或显式注入较短窗口，不能用脆弱的同阈值竞速。

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/driver
rtk proxy bun run --cwd packages/plugins/cursor test:unit
rtk proxy git diff --check
```

- [ ] **Step 5: 提交批次交接。**

```sh
rtk proxy git add packages/plugins/cursor/src/runtime/driver
rtk proxy git commit -m "fix(cursor): drain MCP tool batches before handoff" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 4: 统一终态、阶段超时与取消清理

**Files:**

- Create: packages/plugins/cursor/src/runtime/driver/lifecycle.ts
- Modify: [driver.ts](../../../packages/plugins/cursor/src/runtime/driver/driver.ts)
- Test: packages/plugins/cursor/src/runtime/driver/driver.test.ts
- Reuse: driver/test-support.ts；runtime/protocol-error.ts

**Interfaces:**

- Consumes: CursorRunTiming（Task 3）；CursorProtocolError（Task 1）；cursorToolState、commitCursorTools（Task 2）。
- Produces private createRunLifecycle({ limits, onFinish, onFailure, cleanup })，返回 noteFrame(progress)、turnEnded()、finish(reason)、fail(error)、settled()、snapshot()。
- limits 精确字段：firstFrameTimeoutMs、frameSilenceTimeoutMs、noProgressTimeoutMs、turnEndGraceMs，均为 number。
- onFinish(reason: 'tool-handoff' | 'turn-ended' | 'connect-end'): void；onFailure(error: unknown): void；cleanup(error?: unknown): void。
- snapshot(): { elapsedMs: number; frameCount: number; lastInboundAgeMs: number; lastProgressAgeMs: number }。
- Preserves: CursorTransport 接口、通用 capture 的 300 秒期限，不给 server 增加另一套 timer。

- [ ] **Step 1: 写不依赖 HTTP EOF 的终止回归。**

```ts
test('successful Connect END_STREAM finishes before HTTP EOF', async () => {
  const h = runHarness();
  h.send(updateFrame({ case: 'textDelta', value: { text: 'OK' } }));
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await h.drained; // 故意不调用 eof()
  await h.result;
  expect(h.parts.filter((p) => p.type === 'finish')).toHaveLength(1);
  expect(h.closeCount()).toBe(1);
});

test('an error envelope wins over a pending tool handoff', async () => {
  jest.useFakeTimers();
  const h = runHarness();
  h.send(execFrame('a', 'docs'));
  await settleMicrotasks();
  h.send({ flags: 2, payload: new TextEncoder().encode('{"error":{"code":"internal","message":"upstream failed"}}') });
  await expect(h.result).rejects.toThrow('upstream failed');
  jest.advanceTimersByTime(1000);
  expect(h.parts.some((p) => p.type === 'finish')).toBe(false);
  expect(h.closeCount()).toBe(1);
});

test('turnEnded grace closes a held-open text run once', async () => {
  jest.useFakeTimers();
  const h = runHarness({ timing: { turnEndGraceMs: 500 } });
  h.send(updateFrame({ case: 'textDelta', value: { text: 'OK' } }));
  h.send(updateFrame({ case: 'turnEnded', value: {} }));
  await settleMicrotasks();
  jest.advanceTimersByTime(499);
  await settleMicrotasks();
  expect(h.parts.some((p) => p.type === 'finish')).toBe(false);
  jest.advanceTimersByTime(1);
  await h.drained;
  expect(h.parts.filter((p) => p.type === 'finish')).toHaveLength(1);
  h.fail(new Error('late socket close'));
  await expect(h.result).resolves.toBeDefined();
});
```

增加 pending started + 成功 END_STREAM 场景，断言 cursor_tool_input_incomplete，不能出现 executable call。现有 EOF 无 turnEnded、非零 trailers 的测试保留，并统一断言错误在 stream 与 result 两个渠道都能看到。

- [ ] **Step 2: 运行上述回归，记录 held-open 测试不能完成。**

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/driver -t 'END_STREAM finishes|error envelope wins|turnEnded grace'
```

预期旧实现等待 HTTP EOF 或缺少 turnEnded 收尾；Bun 测试超时即为失败，不等待 300 秒。

- [ ] **Step 3: 实现私有生命周期拥有者。**

lifecycle.ts 导入 CursorProtocolError；实现如下。type 定义和函数留在本私有文件，外部模块不引用它：

```ts
type FinishReason = 'tool-handoff' | 'turn-ended' | 'connect-end';
type Limits = {
  firstFrameTimeoutMs: number;
  frameSilenceTimeoutMs: number;
  noProgressTimeoutMs: number;
  turnEndGraceMs: number;
};
type Hooks = {
  limits: Limits;
  onFinish(reason: FinishReason): void;
  onFailure(error: unknown): void;
  cleanup(error?: unknown): void;
};

export function createRunLifecycle(hooks: Hooks) {
  const startedAt = Date.now();
  let lastInbound = startedAt;
  let lastProgress = startedAt;
  let frameCount = 0;
  let terminal = false;
  let ending = false;
  let first: ReturnType<typeof setTimeout> | undefined;
  let health: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    clearTimeout(first);
    clearTimeout(health);
    clearTimeout(grace);
    first = health = grace = undefined;
  };
  const settle = (reason?: FinishReason, error?: unknown) => {
    if (terminal) return;
    terminal = true;
    clear();
    let failure = error;
    try {
      if (reason === undefined) hooks.onFailure(error);
      else hooks.onFinish(reason);
    } catch (caught) {
      failure = caught;
      hooks.onFailure(caught);
    } finally {
      hooks.cleanup(failure);
    }
  };
  const armHealth = () => {
    clearTimeout(health);
    if (terminal || ending) return;
    const silenceDeadline = lastInbound + hooks.limits.frameSilenceTimeoutMs;
    const progressDeadline = lastProgress + hooks.limits.noProgressTimeoutMs;
    const deadline = Math.min(silenceDeadline, progressDeadline);
    health = setTimeout(
      () => {
        const now = Date.now();
        if (now < deadline) {
          armHealth();
          return;
        }
        const silent = now >= lastInbound + hooks.limits.frameSilenceTimeoutMs;
        settle(
          undefined,
          new CursorProtocolError(
            silent ? 'cursor_frame_silence_timeout' : 'cursor_no_progress_timeout',
            silent ? 'Cursor sent no inbound frames before completion.' : 'Cursor made no progress before completion.',
          ),
        );
      },
      Math.max(0, deadline - Date.now()),
    );
  };
  first = setTimeout(
    () =>
      settle(undefined, new CursorProtocolError('cursor_first_frame_timeout', 'Cursor did not send its first frame.')),
    hooks.limits.firstFrameTimeoutMs,
  );

  return {
    noteFrame(progress: boolean) {
      if (terminal) return;
      const now = Date.now();
      lastInbound = now;
      if (frameCount++ === 0) {
        lastProgress = now;
        clearTimeout(first);
        first = undefined;
      }
      if (progress) lastProgress = now;
      armHealth();
    },
    turnEnded() {
      if (terminal || ending) return;
      ending = true;
      clearTimeout(first);
      clearTimeout(health);
      first = health = undefined;
      grace = setTimeout(() => settle('turn-ended'), hooks.limits.turnEndGraceMs);
    },
    finish: (reason: FinishReason) => settle(reason),
    fail: (error: unknown) => settle(undefined, error),
    settled: () => terminal,
    snapshot: () => ({
      elapsedMs: Date.now() - startedAt,
      frameCount,
      lastInboundAgeMs: Date.now() - lastInbound,
      lastProgressAgeMs: Date.now() - lastProgress,
    }),
  };
}
```

cleanup 必须为不会抛出的资源释放函数。close/end 异常在 driver 中捕获，不能让 timer 产生 unhandled exception。onFailure 只 error controller（未取消时）和 reject result，不能再递归调用 lifecycle.fail。

driver 创建内部 AbortController；openRun 接收内部与外部 signal 的 AbortSignal.any 组合。生命周期在 await openRun 之前创建；首帧超时、外部取消先结算，再 abort 内部 signal。openRun 迟到返回时先查 settled，立即 close 并 return，不写 run request。

原 finishToolHandoff 改为 lifecycle.finish('tool-handoff')；hooks.onFinish 执行以下统一收尾：

```ts
const current = cursorToolState(accumulator);
if (current.openCount > 0) {
  throw new CursorProtocolError('cursor_tool_input_incomplete', 'Cursor ended with incomplete MCP input.');
}
const calls = cursorCompletedTools(accumulator);
for (const part of commitCursorTools(accumulator)) controller.enqueue(part);
for (const part of finalizeCursorStream(accumulator)) controller.enqueue(part);
controller.close();
settleResult({
  conversationState,
  checkpointUsable: sawCheckpoint && calls.length === 0,
  pendingToolCalls: new Map(calls.map((call) => [call.outerCallId, call.nestedToolCallId])),
  toolCalls: calls,
  assistantText,
  blobStore: input.blobStore,
});
```

将原 result resolver 明确命名 settleResult。cleanup 清除 Task 3 handoff timer、heartbeat interval、外部 abort listener，关闭 activeRun；终止 timer 不留到 finally 才清除。正常成功不把 cleanup 的网络关闭再视为模型失败。

Connect END_STREAM 的处理改为解析后立即调用 lifecycle.finish('connect-end') 或 fail(error) 并退出帧循环；不 await trailers。turnEnded 调用 lifecycle.turnEnded()，清除工具收尾 timer 并禁止重开，让固定 500 ms deadline 接管。普通 EOF 才读取已终止传输的 trailers，再按 spec 表判定。

每个解码帧完成处理后 noteFrame(meaningful)。meaningful 的条件为：非空 text/thinking、正数 tokenDelta、MCP progressRevision 增加、成功处理的 KV、非 MCP exec、approval-only 拒绝或 query 回复。普通 MCP exec 仅按 progressRevision 判断；原样重复 MCP、heartbeat/checkpoint 为 false，不能因它属于 exec 就绕过进展判定。Connect envelope 直接结束，因此无需重开健康计时。heartbeat write 包在 try/catch 中，异常调用 lifecycle.fail。

- [ ] **Step 4: 用假时钟覆盖阶段差异、清理和迟到句柄。**

```ts
test('heartbeats prevent silence timeout but cannot prevent no-progress timeout', async () => {
  jest.useFakeTimers();
  const h = runHarness({
    timing: {
      firstFrameTimeoutMs: 20,
      frameSilenceTimeoutMs: 30,
      noProgressTimeoutMs: 80,
    },
  });
  h.send(updateFrame({ case: 'heartbeat', value: {} }));
  await settleMicrotasks();
  for (let i = 0; i < 3; i++) {
    jest.advanceTimersByTime(25);
    h.send(updateFrame({ case: 'heartbeat', value: {} }));
    await settleMicrotasks();
  }
  jest.advanceTimersByTime(5);
  await expect(h.result).rejects.toMatchObject({ code: 'cursor_no_progress_timeout' });
  const writes = h.writes.length;
  jest.advanceTimersByTime(300000);
  expect(h.writes).toHaveLength(writes);
  expect(h.closeCount()).toBe(1);
});

test('silence and first-frame waits have distinct errors', async () => {
  jest.useFakeTimers();
  const a = runHarness({ timing: { firstFrameTimeoutMs: 20 } });
  jest.advanceTimersByTime(20);
  await expect(a.result).rejects.toMatchObject({ code: 'cursor_first_frame_timeout' });
  const b = runHarness({ timing: { frameSilenceTimeoutMs: 30, noProgressTimeoutMs: 80 } });
  b.send(updateFrame({ case: 'textDelta', value: { text: 'progress' } }));
  await settleMicrotasks();
  jest.advanceTimersByTime(30);
  await expect(b.result).rejects.toMatchObject({ code: 'cursor_frame_silence_timeout' });
});
```

进一步覆盖取消与迟到句柄；runHarness 的第二参数 openGate 已在 Task 1 定义：

```ts
test('cancel before protocol success preserves the cancellation reason', async () => {
  const h = runHarness();
  await settleMicrotasks();
  const reason = new Error('user canceled');
  await h.cancel(reason);
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await expect(h.result).rejects.toBe(reason);
  expect(h.parts.some((p) => p.type === 'finish')).toBe(false);
  expect(h.closeCount()).toBe(1);
});

test('an abort after protocol success cannot replace success', async () => {
  const signal = new AbortController();
  const h = runHarness({ signal: signal.signal });
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await h.drained;
  signal.abort(new Error('late cancel'));
  await expect(h.result).resolves.toBeDefined();
  expect(h.closeCount()).toBe(1);
});

test('a late openRun handle is closed without writing after cancellation', async () => {
  const gate = Promise.withResolvers<void>();
  const h = runHarness({}, gate.promise);
  const reason = new Error('cancel before open');
  await h.cancel(reason);
  await expect(h.result).rejects.toBe(reason);
  gate.resolve();
  await settleMicrotasks();
  expect(h.closeCount()).toBe(1);
  expect(h.writes).toHaveLength(0);
});

test('a pending MCP input fails on successful protocol end', async () => {
  const h = runHarness();
  h.send(
    updateFrame({
      case: 'toolCallStarted',
      value: {
        callId: 'outer',
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: { name: 'search', toolName: 'search', toolCallId: 'nested', args: {} },
            },
          },
        },
      },
    }),
  );
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await expect(h.result).rejects.toMatchObject({ code: 'cursor_tool_input_incomplete' });
  await expect(h.drained).rejects.toMatchObject({ code: 'cursor_tool_input_incomplete' });
  expect(h.parts.some((p) => p.type === 'tool-call')).toBe(false);
});
```

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/driver
rtk proxy bun run --cwd packages/plugins/cursor test:unit
rtk proxy git diff --check
```

- [ ] **Step 5: 提交终止与超时修复。**

```sh
rtk proxy git add packages/plugins/cursor/src/runtime/driver
rtk proxy git commit -m "fix(cursor): settle protocol terminals and bound stalled runs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 5: 保存结构化工具历史并修复增量续接

**Files:**

- Create: packages/plugins/cursor/src/runtime/history/root-messages.ts
- Create: packages/plugins/cursor/src/runtime/history/tool-result.ts
- Create: packages/plugins/cursor/src/runtime/cursor-model/test-support.ts
- Modify: [history.ts](../../../packages/plugins/cursor/src/runtime/history/history.ts#L51)、history/index.ts
- Modify: [run-request.ts](../../../packages/plugins/cursor/src/runtime/run-request/run-request.ts#L77)
- Modify: [cursor-model.ts](../../../packages/plugins/cursor/src/runtime/cursor-model/cursor-model.ts#L168)
- Test: runtime/history/history.test.ts、runtime/run-request/run-request.test.ts、runtime/cursor-model/cursor-model.test.ts（前缀 packages/plugins/cursor/src/）

**Interfaces:**

- Consumes: CursorCompletedToolCall、CursorTurnResult.assistantText/toolCalls；现有 storeCursorBlob/readCursorBlob、toWireName、buildCursorRunRequestBytes。
- Preserves: buildRootPromptMessagesJson(prompt, systemPromptIds, blobStore, activeUserMessageIndex?): Uint8Array[]，其公开入口仍在 history.ts。
- Produces: appendCursorRootHistory(input: { rootPromptMessagesJson: readonly Uint8Array[]; prompt: LanguageModelV4Prompt; blobStore: Map<string, Uint8Array> }): Uint8Array[]。
- Private root helpers: buildRootMessages(prompt, knownCallIds): Record<string, unknown>[]；collectRootCallIds(ids, blobStore): Set<string>；rootToolCallId(id: string): string。
- Private result helpers: toolResultText(part: LanguageModelV4ToolResultPart): string（从现有文件移入，保留 orphan marker）；rootToolResult(part): { result: unknown; isError?: true }。
- Test-only createProtocolFixture(rounds: readonly (readonly ConnectFrame[])[]) 返回 { transport: CursorTransport; runs: AgentRunRequest[]; roots: FixtureRootMessage[][]; closes: number[] }，根消息通过真实 KV 回复读取；另导出 protocolServerFrame(message)、protocolUpdateFrame(message)。
- System 策略：完整历史使用当前 system；增量历史显式提供 system 时替换缓存 system 前缀，没有提供时保留缓存 system，不追加默认 system。

- [ ] **Step 1: 用真实 root blob 解码验证调用与结果配对。**

在 history.test.ts 使用已有 decodeJson。增加如下工具历史夹具与测试：

```ts
const pairedPrompt: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'Compare searches.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 'outer-a', toolName: 'search', input: { query: 'alpha' } },
      { type: 'tool-call', toolCallId: 'outer-b', toolName: 'search', input: { query: 'beta' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'outer-a', toolName: 'search', output: { type: 'text', value: 'RESULT_A' } },
      { type: 'tool-result', toolCallId: 'outer-b', toolName: 'search', output: { type: 'text', value: 'RESULT_B' } },
    ],
  },
];

test('root history preserves same-name calls with different arguments and results', () => {
  const store = new Map<string, Uint8Array>();
  const ids = buildRootPromptMessagesJson(pairedPrompt, [], store, -1);
  const messages = ids.map((id) => decodeJson(store, id));
  const calls = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .filter((p) => p.type === 'tool-call');
  const results = messages.filter((m) => m.role === 'tool').flatMap((m) => m.content);
  expect(calls.map((c) => c.args)).toEqual([{ query: 'alpha' }, { query: 'beta' }]);
  expect(results.map((r) => r.result)).toEqual(['RESULT_A', 'RESULT_B']);
  expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
  expect(calls.every((c) => /^[a-zA-Z0-9_-]+$/.test(c.toolCallId))).toBe(true);
});

test('incremental results pair with calls already in cached root history', () => {
  const store = new Map<string, Uint8Array>();
  const base = buildRootPromptMessagesJson(pairedPrompt.slice(0, 2), [], store, -1);
  const ids = appendCursorRootHistory({
    rootPromptMessagesJson: base,
    prompt: pairedPrompt.slice(2),
    blobStore: store,
  });
  const messages = ids.map((id) => decodeJson(store, id));
  expect(
    messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .filter((p) => p.type === 'tool-call'),
  ).toHaveLength(2);
  expect(
    messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .map((p) => p.result),
  ).toEqual(['RESULT_A', 'RESULT_B']);
});
```

- [ ] **Step 2: 确认旧 builder 丢失 assistant/tool 结构。**

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/history -t 'root history preserves|incremental results pair'
```

旧实现没有两条 tool-call，结果为 user 文本。新增 helper 编译后仍必须观察到这个行为失败，才进行结构替换。

- [ ] **Step 3: 提取 root 构造与结果表示，保留 turns 逻辑。**

history.ts 当前接近 400 行；把 root 构造移入 root-messages.ts，把现有 toolResultText 移入 tool-result.ts，避免两个文件互相导入。history.ts 用公开 wrapper 调用私有实现，history/index.ts 仅导出公开 wrapper。buildConversationTurns/applyMcpToolResults/encodeMcpResult 保持其原有 protobuf 语义。

rootToolCallId 使用可逆、安全字符编码，避免来自 Responses 的组合 ID 含有竖线时触发上游拒绝。它只影响内部 root，不改变客户端 ID 或 pending nested 映射：

```ts
function rootToolCallId(id: string): string {
  return 'aio_' + Buffer.from(id, 'utf8').toString('base64url');
}
```

所有来自客户端的 ID 编码一次；读取已有 root 的 ID 时不得再次编码。已存 root 的调用 ID 集合与新结果编码后的 ID 匹配。测试增加 outer ID 含竖线、斜杠、Unicode 的场景，断言结果配对、两种不同 ID 不合并、输出只含安全字符。

tool-result.ts 保留旧 orphan formatter，再新增：

```ts
export function rootToolResult(part: LanguageModelV4ToolResultPart): { result: unknown; isError?: true } {
  const out = part.output;
  switch (out.type) {
    case 'json':
      return { result: out.value };
    case 'error-json':
      return { result: out.value, isError: true };
    case 'text':
      return { result: out.value.trim() ? out.value : '(no output)' };
    case 'error-text':
      return { result: out.value.trim() ? out.value : '(no output)', isError: true };
    case 'execution-denied':
      return {
        result: '[Tool Execution Denied]\n' + (out.reason?.trim() || 'Tool execution was denied.'),
        isError: true,
      };
    case 'content': {
      const text = out.value.map((entry) => (entry.type === 'text' ? entry.text : '[' + entry.type + ']')).join('\n');
      return { result: text.trim() ? text : '(no output)' };
    }
  }
}
```

root-messages.ts 导入 Buffer、LanguageModelV4Prompt/LanguageModelV4ToolResultPart、isPlainObject、storeCursorBlob/readCursorBlob、toWireName、extractV4UserText、toolResultText/rootToolResult。除本目录 wrapper 外不导出到高层 barrel。完整构造如下：

```ts
function buildRootMessages(prompt: LanguageModelV4Prompt, knownCallIds: Set<string>): Record<string, unknown>[] {
  for (const message of prompt) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') knownCallIds.add(rootToolCallId(part.toolCallId));
    }
  }
  const messages: Record<string, unknown>[] = [];
  const pushResult = (part: LanguageModelV4ToolResultPart) => {
    const id = rootToolCallId(part.toolCallId);
    messages.push(
      knownCallIds.has(id)
        ? {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: id,
                toolName: toWireName(part.toolName),
                ...rootToolResult(part),
              },
            ],
          }
        : { role: 'user', content: [{ type: 'text', text: toolResultText(part) }] },
    );
  };
  for (const message of prompt) {
    if (message.role === 'user') {
      const text = extractV4UserText(message.content);
      const content: unknown[] = text.length > 0 ? [{ type: 'text', text }] : [];
      for (const part of message.content) {
        if (
          part.type !== 'file' ||
          (part.mediaType !== 'image' && !part.mediaType.startsWith('image/')) ||
          part.data.type !== 'data'
        )
          continue;
        const data =
          part.data.data instanceof Uint8Array
            ? Buffer.from(part.data.data).toString('base64')
            : Buffer.from(part.data.data, 'base64').toString('base64');
        content.push({ type: 'file', mediaType: part.mediaType, data: { type: 'data', data } });
      }
      if (content.length > 0) messages.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      let content: Record<string, unknown>[] = [];
      const flush = () => {
        if (content.length > 0) messages.push({ role: 'assistant', content });
        content = [];
      };
      for (const part of message.content) {
        if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text });
        else if (part.type === 'tool-call')
          content.push({
            type: 'tool-call',
            toolCallId: rootToolCallId(part.toolCallId),
            toolName: toWireName(part.toolName),
            args: part.input,
          });
        else if (part.type === 'tool-result') {
          flush();
          pushResult(part);
        }
      }
      flush();
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') pushResult(part);
      }
    }
  }
  return messages;
}

function readRootMessage(id: Uint8Array, store: ReadonlyMap<string, Uint8Array>): Record<string, unknown> | undefined {
  const bytes = readCursorBlob(store, id);
  if (bytes === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRootSystemMessage(id: Uint8Array, store: ReadonlyMap<string, Uint8Array>): boolean {
  return readRootMessage(id, store)?.role === 'system';
}

function collectRootCallIds(ids: readonly Uint8Array[], store: ReadonlyMap<string, Uint8Array>): Set<string> {
  const known = new Set<string>();
  for (const id of ids) {
    const message = readRootMessage(id, store);
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isPlainObject(part) && part.type === 'tool-call' && typeof part.toolCallId === 'string') {
        known.add(part.toolCallId);
      }
    }
  }
  return known;
}

export function buildCursorRootMessages(
  prompt: LanguageModelV4Prompt,
  systemPromptIds: Uint8Array[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex: number,
): Uint8Array[] {
  const history = activeUserMessageIndex < 0 ? prompt : prompt.slice(0, activeUserMessageIndex);
  return [
    ...systemPromptIds,
    ...buildRootMessages(history, new Set()).map((message) =>
      storeCursorBlob(blobStore, new TextEncoder().encode(JSON.stringify(message))),
    ),
  ];
}
```

history.ts 的 buildRootPromptMessagesJson 保留原签名/默认 activeUserMessageIndex，函数体改为 return buildCursorRootMessages(prompt, systemPromptIds, blobStore, activeUserMessageIndex)。私有模块导入所需的所有类型使用 type import。

appendCursorRootHistory 实现：

```ts
export function appendCursorRootHistory(input: {
  rootPromptMessagesJson: readonly Uint8Array[];
  prompt: LanguageModelV4Prompt;
  blobStore: Map<string, Uint8Array>;
}): Uint8Array[] {
  const base = [...input.rootPromptMessagesJson];
  const known = collectRootCallIds(base, input.blobStore);
  const explicitSystem = input.prompt.filter((m) => m.role === 'system');
  const prefix =
    explicitSystem.length === 0
      ? base
      : [
          ...explicitSystem.map((m) =>
            storeCursorBlob(
              input.blobStore,
              new TextEncoder().encode(
                JSON.stringify({
                  role: 'system',
                  content: m.content,
                }),
              ),
            ),
          ),
          ...base.filter((id) => !isRootSystemMessage(id, input.blobStore)),
        ];
  const tail = buildRootMessages(
    input.prompt.filter((m) => m.role !== 'system'),
    known,
  );
  return [...prefix, ...tail.map((m) => storeCursorBlob(input.blobStore, new TextEncoder().encode(JSON.stringify(m))))];
}
```

history.ts 通过 wrapper 公开追加操作，避免其他模块直接导入私有 root-messages.ts：

```ts
import { appendCursorRootHistory as appendRootHistory, buildCursorRootMessages } from './root-messages';

export function appendCursorRootHistory(input: {
  rootPromptMessagesJson: readonly Uint8Array[];
  prompt: LanguageModelV4Prompt;
  blobStore: Map<string, Uint8Array>;
}): Uint8Array[] {
  return appendRootHistory(input);
}
```

history/index.ts 仅增加上述公开 wrapper 的 export。

- [ ] **Step 4: 在交接缓存时保存实际调用，并在增量请求使用缓存索引。**

cursor-model.ts 的 result.then 中，用“发送本轮时使用的 conversationState.rootPromptMessagesJson”作 base，不能从 turn.conversationState 中取可能过时的 root。构造尾部 V4 prompt：

```ts
const active = options.prompt.at(-1);
const tail: LanguageModelV4Prompt = [
  ...(active?.role === 'user' ? [active] : []),
  {
    role: 'assistant',
    content: [
      ...(turn.assistantText ? [{ type: 'text' as const, text: turn.assistantText }] : []),
      ...turn.toolCalls.map((call) => ({
        type: 'tool-call' as const,
        toolCallId: call.outerCallId,
        toolName: call.toolName,
        input: JSON.parse(call.input),
      })),
    ],
  },
];
const rootPromptMessagesJson = appendCursorRootHistory({
  rootPromptMessagesJson: conversationState.rootPromptMessagesJson,
  prompt: tail,
  blobStore: turn.blobStore,
});
const cachedConversationState = create(ConversationStateStructureSchema, {
  ...turn.conversationState,
  rootPromptMessagesJson,
});
```

next.conversationState 改为 toBinary(...cachedConversationState)。保留原 identityScope、affinity 检查、pending 合并和 compare-and-set；失败分支仍不写缓存。

run-request.ts 原增量拼接分支改为：

```ts
const hasFullToolHistory =
  promptTurns.length > 0 ||
  prompt.some((message) => message.role === 'assistant' && message.content.some((part) => part.type === 'tool-call'));
const rootPromptMessagesJson =
  isPendingResume && reusableState !== undefined
    ? hasFullToolHistory
      ? promptRootMessages
      : appendCursorRootHistory({
          rootPromptMessagesJson: reusableState.rootPromptMessagesJson,
          prompt,
          blobStore,
        })
    : (reusableState?.rootPromptMessagesJson ?? promptRootMessages);
```

完整历史仍使用当前 promptRootMessages；当完整历史只有 system/assistant/tool 而没有 user 时，用“包含原调用的 assistant tool-call”也识别为完整工具历史，避免把同一调用重复追加到缓存。上面的 hasFullToolHistory 将两种情况合并。

- [ ] **Step 5: 验证无 checkpoint 的真实双轮模型续接及结果种类。**

新建 cursor-model/test-support.ts，提供可在本任务独立运行的真实 Run/KV 夹具。它逐个请求 Run 中引用的 root blob，只有实际收到 getBlobResult 才发送脚本帧；HTTP 不自然 EOF，靠 driver 关闭，因此也能保护协议结束行为。

```ts
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { AgentClientMessageSchema, AgentServerMessageSchema, type AgentRunRequest } from '../../gen/agent_pb';
import type { ConnectFrame } from '../../wire/frame';
import type { CursorTransport } from '../../wire/transport';

export type FixtureRootMessage = {
  role?: string;
  content?:
    | string
    | Array<{
        type?: string;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        text?: string;
      }>;
};

export const protocolServerFrame = (message: Record<string, unknown>): ConnectFrame => ({
  flags: 0,
  payload: toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message } as never)),
});
export const protocolUpdateFrame = (message: Record<string, unknown>): ConnectFrame =>
  protocolServerFrame({ case: 'interactionUpdate', value: { message } });

export function createProtocolFixture(rounds: readonly (readonly ConnectFrame[])[]) {
  const runs: AgentRunRequest[] = [];
  const roots: FixtureRootMessage[][] = [];
  const closes: number[] = [];
  let opened = 0;
  const transport: CursorTransport = {
    unary: async () => {
      throw new Error('unused');
    },
    openRun: async () => {
      const round = opened++;
      const script = rounds[round];
      if (script === undefined) throw new Error('unexpected extra Cursor Run');
      const queue: ConnectFrame[] = [];
      const trailers = Promise.withResolvers<Record<string, string>>();
      const pending = new Set<number>();
      let wake: (() => void) | undefined;
      let closed = false;
      roots[round] = [];
      closes[round] = 0;
      const notify = () => {
        const next = wake;
        wake = undefined;
        next?.();
      };
      const sendScript = () => {
        queue.push(...script);
        notify();
      };
      return {
        write(bytes) {
          const message = fromBinary(AgentClientMessageSchema, bytes.subarray(5)).message;
          if (message.case === 'runRequest') {
            runs[round] = message.value;
            const ids = message.value.conversationState?.rootPromptMessagesJson ?? [];
            ids.forEach((blobId, index) => {
              pending.add(index + 1);
              queue.push(
                protocolServerFrame({
                  case: 'kvServerMessage',
                  value: {
                    id: index + 1,
                    message: { case: 'getBlobArgs', value: { blobId } },
                  },
                }),
              );
            });
            if (pending.size === 0) sendScript();
            else notify();
          } else if (message.case === 'kvClientMessage') {
            const reply = message.value;
            if (reply.message.case !== 'getBlobResult' || !pending.delete(reply.id)) {
              throw new Error('unexpected KV response');
            }
            const data = reply.message.value.blobData;
            if (data === undefined) throw new Error('root blob unavailable');
            roots[round]![reply.id - 1] = JSON.parse(new TextDecoder().decode(data)) as FixtureRootMessage;
            if (pending.size === 0) sendScript();
          }
        },
        end() {},
        close() {
          closes[round]++;
          closed = true;
          trailers.resolve({});
          notify();
        },
        trailers: trailers.promise,
        frames: (async function* () {
          for (;;) {
            if (closed) return;
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        })(),
      };
    },
  };
  return { transport, runs, roots, closes };
}
```

cursor-model.test.ts 引入上述三个函数，复用现有 runtimeWith/callOptions（它们提供测试凭证、真实 CursorSessionStore 和逻辑会话）。以下测试直接经过模型及协议，第一轮故意没有 checkpoint：

```ts
test('a result-only second turn reads the actual tool history without a checkpoint', async () => {
  const f = createProtocolFixture([
    [
      protocolUpdateFrame({
        case: 'toolCallStarted',
        value: {
          callId: 'outer|a',
          toolCall: {
            tool: {
              case: 'mcpToolCall',
              value: {
                args: { name: 'search', toolName: 'search', toolCallId: 'nested-a', args: {} },
              },
            },
          },
        },
      }),
      protocolServerFrame({
        case: 'execServerMessage',
        value: {
          id: 1,
          execId: 'exec-a',
          message: {
            case: 'mcpArgs',
            value: {
              name: 'search',
              toolName: 'search',
              toolCallId: 'nested-a',
              args: { query: new TextEncoder().encode('"docs"') },
            },
          },
        },
      }),
    ],
    [
      protocolUpdateFrame({ case: 'textDelta', value: { text: 'done' } }),
      { flags: 2, payload: new TextEncoder().encode('{}') },
    ],
  ]);
  const model = createCursorLanguageModel('composer-2', runtimeWith(f.transport, new CursorSessionStore()));
  const first = await model.doGenerate({
    ...callOptions(),
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'search the docs' }] }],
    tools: [
      {
        type: 'function',
        name: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
  });
  expect(first.content.find((p) => p.type === 'tool-call')).toMatchObject({
    toolCallId: 'outer|a',
    input: '{"query":"docs"}',
  });
  await model.doGenerate({
    ...callOptions(),
    prompt: [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'outer|a',
            toolName: 'search',
            output: { type: 'text', value: 'FOUND' },
          },
        ],
      },
    ],
  });
  const root = f.roots[1]!;
  const contents = root.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const call = contents.find((p) => p.type === 'tool-call')!;
  const result = contents.find((p) => p.type === 'tool-result')!;
  expect(call.args).toEqual({ query: 'docs' });
  expect(result.result).toBe('FOUND');
  expect(result.toolCallId).toBe(call.toolCallId);
  expect(call.toolCallId).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(root.filter((m) => m.role === 'user' && JSON.stringify(m.content).includes('search the docs'))).toHaveLength(
    1,
  );
  expect(f.runs[1]?.action?.action.case).toBe('resumeAction');
  expect(f.closes).toEqual([1, 1]);
});
```

在 history.test.ts 增加 type LanguageModelV4ToolResultPart 导入，通过公开 builder 验证结果矩阵，不为私有 formatter 单独测试实现细节：

```ts
test.each([
  { output: { type: 'text', value: '' }, result: '(no output)', isError: undefined },
  { output: { type: 'content', value: [] }, result: '(no output)', isError: undefined },
  { output: { type: 'json', value: { count: 2 } }, result: { count: 2 }, isError: undefined },
  { output: { type: 'error-text', value: 'denied' }, result: 'denied', isError: true },
  { output: { type: 'error-json', value: { code: 7 } }, result: { code: 7 }, isError: true },
  {
    output: { type: 'execution-denied', reason: 'User declined' },
    result: '[Tool Execution Denied]\nUser declined',
    isError: true,
  },
] satisfies Array<{ output: LanguageModelV4ToolResultPart['output']; result: unknown; isError: true | undefined }>)(
  'root preserves result semantics: $output.type',
  ({ output, result, isError }) => {
    const store = new Map<string, Uint8Array>();
    const prompt: LanguageModelV4Prompt = [
      ...pairedPrompt.slice(0, 2),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'outer-a',
            toolName: 'search',
            output: structuredClone(output),
          },
        ],
      },
    ];
    const root = buildRootPromptMessagesJson(prompt, [], store, -1).map((id) => decodeJson(store, id));
    const actual = root.find((m) => m.role === 'tool').content[0];
    expect(actual.result).toEqual(result);
    expect(actual.isError).toBe(isError);
  },
);

test('partial results keep unmatched calls pending', () => {
  const prompt: LanguageModelV4Prompt = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'outer-a',
          toolName: 'search',
          output: { type: 'text', value: 'RESULT_A' },
        },
      ],
    },
  ];
  const patched = applyMcpToolResults({
    prompt,
    turns: [],
    pendingToolCalls: new Map([
      ['outer-a', 'nested-a'],
      ['outer-b', 'nested-b'],
    ]),
    blobStore: new Map(),
  });
  expect([...patched.pendingToolCalls]).toEqual([['outer-b', 'nested-b']]);
});

test('incremental system replaces only when explicitly supplied', () => {
  const store = new Map<string, Uint8Array>();
  const systemId = storeCursorBlob(store, new TextEncoder().encode('{"role":"system","content":"original"}'));
  const base = buildRootPromptMessagesJson(pairedPrompt.slice(0, 2), [systemId], store, -1);
  const implicit = appendCursorRootHistory({
    rootPromptMessagesJson: base,
    prompt: pairedPrompt.slice(2),
    blobStore: store,
  });
  const explicit = appendCursorRootHistory({
    rootPromptMessagesJson: base,
    prompt: [{ role: 'system', content: 'updated' }, ...pairedPrompt.slice(2)],
    blobStore: store,
  });
  const systems = (ids: Uint8Array[]) => ids.map((id) => decodeJson(store, id)).filter((m) => m.role === 'system');
  expect(systems(implicit)).toEqual([{ role: 'system', content: 'original' }]);
  expect(systems(explicit)).toEqual([{ role: 'system', content: 'updated' }]);
});

test('special client ids remain distinct and are not encoded twice on append', () => {
  const clientIds = ['call|1/中文', 'call_1_中文'];
  const store = new Map<string, Uint8Array>();
  const prompt: LanguageModelV4Prompt = [
    {
      role: 'assistant',
      content: clientIds.map((id) => ({
        type: 'tool-call',
        toolCallId: id,
        toolName: 'search',
        input: { query: id },
      })),
    },
  ];
  const base = buildRootPromptMessagesJson(prompt, [], store, -1);
  const appended = appendCursorRootHistory({
    rootPromptMessagesJson: base,
    blobStore: store,
    prompt: [
      {
        role: 'tool',
        content: clientIds.map((id) => ({
          type: 'tool-result',
          toolCallId: id,
          toolName: 'search',
          output: { type: 'text', value: id },
        })),
      },
    ],
  }).map((id) => decodeJson(store, id));
  const calls = appended.filter((m) => m.role === 'assistant').flatMap((m) => m.content);
  const results = appended.filter((m) => m.role === 'tool').flatMap((m) => m.content);
  expect(new Set(calls.map((c) => c.toolCallId)).size).toBe(2);
  expect(calls.every((c) => /^[a-zA-Z0-9_-]+$/.test(c.toolCallId))).toBe(true);
  expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
  expect(results.map((r) => r.result)).toEqual(clientIds);
});
```

保留 orphan fallback 及既有 MCP 图片测试；这些回归需要继续通过。

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/history packages/plugins/cursor/src/runtime/run-request packages/plugins/cursor/src/runtime/cursor-model
rtk proxy bun run --cwd packages/plugins/cursor test:unit
rtk proxy git diff --check
rtk proxy git add packages/plugins/cursor/src/runtime/history packages/plugins/cursor/src/runtime/run-request packages/plugins/cursor/src/runtime/cursor-model
rtk proxy git commit -m "fix(cursor): preserve structured tool history during resume" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 6: 接入可关联、无敏感内容的阶段日志

**Files:**

- Create: packages/plugins/cursor/src/runtime/driver/diagnostics.ts
- Modify: packages/plugins/cursor/src/plugin/plugin.ts
- Modify: packages/plugins/cursor/src/runtime/runtime.ts
- Modify: packages/plugins/cursor/src/runtime/provider/provider.ts
- Modify: packages/plugins/cursor/src/runtime/cursor-model/cursor-model.ts
- Modify: packages/plugins/cursor/src/runtime/driver/driver.ts
- Test: packages/plugins/cursor/src/runtime/driver/driver.test.ts
- Test: packages/plugins/cursor/src/runtime/cursor-model/cursor-model.test.ts

**Interfaces:**

- Consumes: PluginApi.logger、Logger（@aio-proxy/plugin-sdk），以及 Task 4 lifecycle.snapshot()；RuntimeContext 没有 logger。
- Produces: CursorRuntimeDependencies、CursorProviderRuntime、CursorModelRuntime 和 runCursorTurn input 各增加 readonly logger?: Logger。
- Produces: runCursorTurn input.diagnosticsContext?: { requestId: string; providerId?: string; modelId: string; resumeMode: 'fresh' | 'checkpoint' | 'tool-results' }。
- Private createRunDiagnostics(logger, context) 返回 (phase, fields?, failed?) => void；字段与阶段精确列于下方代码。所有字段来自当前 Run，没有全局状态。

- [ ] **Step 1: 在真实 driver 上写日志隐私与容错回归。**

在 driver.test.ts 导入 Logger。每个测试独立创建 sink；不要用 console 捕获进程全局日志：

```ts
test('run diagnostics correlate phases without logging request content', async () => {
  const rows: unknown[] = [];
  const sink: Logger['debug'] = (a, b) => {
    rows.push([a, b]);
  };
  const logger: Logger = { debug: sink, info: sink, warn: sink, error: sink, child: () => logger };
  const h = runHarness({
    logger,
    accessToken: 'SECRET_ACCESS_TOKEN',
    diagnosticsContext: {
      requestId: 'req-123',
      providerId: 'cursor-1',
      modelId: 'composer-2',
      resumeMode: 'fresh',
    },
  });
  h.send(updateFrame({ case: 'textDelta', value: { text: 'SECRET_MODEL_TEXT' } }));
  h.send(
    serverFrame({
      case: 'interactionQuery',
      value: {
        id: 52,
        query: { case: 'webSearchRequestQuery', value: {} },
      },
    }),
  );
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await h.drained;
  await h.result;
  const serialized = JSON.stringify(rows);
  expect(serialized).toContain('req-123');
  expect(serialized).toContain('cursor-1');
  expect(serialized).toContain('first-frame');
  expect(serialized).toContain('first-text');
  expect(serialized).toContain('query-reply');
  expect(serialized).toContain('settled');
  expect(serialized).not.toContain('SECRET_ACCESS_TOKEN');
  expect(serialized).not.toContain('SECRET_MODEL_TEXT');
});

test('a throwing log sink cannot change the successful stream', async () => {
  const sink: Logger['debug'] = () => {
    throw new Error('broken sink');
  };
  const logger: Logger = { debug: sink, info: sink, warn: sink, error: sink, child: () => logger };
  const h = runHarness({ logger });
  h.send(updateFrame({ case: 'textDelta', value: { text: 'OK' } }));
  h.send({ flags: 2, payload: new TextEncoder().encode('{}') });
  await h.drained;
  await expect(h.result).resolves.toBeDefined();
  expect(h.parts.filter((p) => p.type === 'finish')).toHaveLength(1);
});
```

- [ ] **Step 2: 跑测试，确认缺少相关阶段日志。**

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/driver -t 'run diagnostics|throwing log sink'
```

先补齐类型使测试可执行；第一条测试在旧实现中应因 rows 为空而失败。

- [ ] **Step 3: 通过插件注册闭包传入 logger。**

plugin.ts 保留 adapter 的其他能力，仅将 definePlugin 注册回调替换为：

```ts
return definePlugin(
  (api) => {
    api.oauth.register({
      ...adapter,
      createRuntime: (context) => createCursorRuntime(context, { ...dependencies, logger: api.logger }),
    });
  },
  {
    displayName: presentationText.pluginLabel ?? 'Cursor',
    description: presentationText.pluginDescription ?? 'Use a Cursor account to access models',
    icon: 'cursor',
  },
);
```

三个 runtime 类型导入 type Logger 并增加可选字段。runtime.ts 从依赖中单独解构 logger，不混入 credentialOptions；provider/model 逐层传入：

```ts
const {
  transport: injectedTransport,
  sessionStore: injectedStore,
  logger,
  ...injectedCredentialOptions
} = dependencies;

const provider = createCursorProviderV4({
  transport,
  credentials: context.credentials,
  sessionStore,
  credentialOptions,
  baseUrl: CURSOR_API_URL,
  modelById,
  ...(logger === undefined ? {} : { logger }),
});
```

provider.ts 的 languageModel 回调中返回的模型对象改为：

```ts
return createCursorLanguageModel(modelId, {
  transport: runtime.transport,
  credentials: runtime.credentials,
  sessionStore: runtime.sessionStore,
  ...(runtime.credentialOptions === undefined ? {} : { credentialOptions: runtime.credentialOptions }),
  ...(runtime.baseUrl === undefined ? {} : { baseUrl: runtime.baseUrl }),
  ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
  model,
});
```

cursor-model.ts 保留已有 logicalSessionKey/routingContinuity 解析；在同文件新增 request ID 的最小读取函数：

```ts
function logicalRequestId(options: SharedV4ProviderOptions | undefined): string {
  const parsed = zod.object({ requestId: zod.string().min(1).max(128) }).safeParse(options?.aioProxy?.logicalRequest);
  return parsed.success && /^[a-zA-Z0-9_.:-]+$/.test(parsed.data.requestId)
    ? parsed.data.requestId
    : crypto.randomUUID();
}
```

调用 runCursorTurn 时追加以下字段；只复用本轮已解析的 priorState/isPendingResume/routing，不再读取凭证字段用于日志：

```ts
const { stream, result } = runCursorTurn({
  transport: runtime.transport,
  accessToken: credential.accessToken,
  ...(runtime.baseUrl === undefined ? {} : { baseUrl: runtime.baseUrl }),
  ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
  requestBytes,
  initialConversationState: conversationState,
  requestContextTools,
  blobStore,
  heartbeatMs: 5_000,
  ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
  diagnosticsContext: {
    requestId: logicalRequestId(options.providerOptions),
    modelId,
    ...(routing === undefined ? {} : { providerId: routing.routedProviderId }),
    resumeMode: isPendingResume ? 'tool-results' : priorState === undefined ? 'fresh' : 'checkpoint',
  },
});
```

- [ ] **Step 4: 实现允许字段投影，并在实际阶段调用。**

diagnostics.ts 代码如下；调用方传入的任意额外属性不会通过投影。记录固定错误 code 或类别，不记录 Error.message/cause（其中可能含 URL/提示词）。原始错误仍沿原 stream/result 传播。

```ts
import type { Logger } from '@aio-proxy/plugin-sdk';

type Phase =
  | 'run-start'
  | 'first-frame'
  | 'first-text'
  | 'tool-ready'
  | 'tool-handoff'
  | 'query-reply'
  | 'turn-ended'
  | 'connect-end'
  | 'http-eof'
  | 'settled';
type Fields = {
  elapsedMs?: number;
  frameCount?: number;
  openToolCount?: number;
  readyToolCount?: number;
  queryCase?: string;
  queryId?: number;
  termination?: string;
  lastInboundAgeMs?: number;
  lastProgressAgeMs?: number;
};
const safeLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

export function createRunDiagnostics(
  logger: Logger | undefined,
  context: {
    requestId: string;
    providerId?: string;
    modelId: string;
    resumeMode: 'fresh' | 'checkpoint' | 'tool-results';
  },
) {
  const base: Record<string, unknown> = {
    requestId: safeLabel(context.requestId) ?? crypto.randomUUID(),
    modelId: safeLabel(context.modelId) ?? 'unknown',
    resumeMode: context.resumeMode,
  };
  const providerId = safeLabel(context.providerId);
  if (providerId !== undefined) base.providerId = providerId;
  return (phase: Phase, fields: Fields = {}, failed = false): void => {
    if (logger === undefined) return;
    const props: Record<string, unknown> = { ...base, phase };
    for (const key of [
      'elapsedMs',
      'frameCount',
      'openToolCount',
      'readyToolCount',
      'queryId',
      'lastInboundAgeMs',
      'lastProgressAgeMs',
    ] as const) {
      const value = fields[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) props[key] = value;
    }
    for (const key of ['queryCase', 'termination'] as const) {
      const value = safeLabel(fields[key]);
      if (value !== undefined) props[key] = value;
    }
    try {
      if (failed) logger.warn('Cursor Run phase', props);
      else logger.debug('Cursor Run phase', props);
    } catch {
      // Logging must not change the stream or terminal result.
    }
  };
}
```

driver 中在创建 lifecycle 前初始化 diagnostics，缺省 context 使用本轮随机 requestId、modelId='unknown'、resumeMode='fresh'。first-frame/first-text 各发一次；tool-ready 在 readyCount 增加时发；query-reply 只在写入成功后发。其余位置按下表接入：

| 位置                                                 | phase / fields                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| openRun 前、首帧 timer 建立后                        | run-start / 初始 snapshot                                                                         |
| 第一个解码成功上游帧，经 noteFrame 后                | first-frame / snapshot                                                                            |
| 第一条非空 textDelta 经 mapper 处理后                | first-text / snapshot                                                                             |
| readyCount 由小变大                                  | tool-ready / snapshot + openToolCount + readyToolCount                                            |
| query 回复写入成功后                                 | query-reply / queryCase + queryId                                                                 |
| turnEnded 第一次出现                                 | turn-ended / snapshot                                                                             |
| Connect envelope 成功解码                            | connect-end / snapshot                                                                            |
| for-await 自然结束且尚未 settled                     | http-eof / snapshot                                                                               |
| onFinish 中验证工具完整后，调用 commitCursorTools 前 | 若有工具，tool-handoff / 工具计数                                                                 |
| 成功完成 controller/result                           | settled / termination=本次 finish reason + snapshot + 工具计数                                    |
| onFailure                                            | settled / termination=CursorProtocolError.code、canceled 或 transport-error + snapshot + 工具计数 |

onFailure 的 canceled 由当前 Run 的取消状态判定，取消用 debug，其他失败用 warn。不能在 onFinish 的工具完整性校验之前记录成功。sample 字段从 lifecycle.snapshot() 获取，计数从 cursorToolState 获取。

- [ ] **Step 5: 验证真实模型调用透传与过滤，提交。**

cursor-model.test.ts 复用现有 makeTransport/runtimeWith/callOptions/lastPartType，验证模型路径实际得到 requestId：

```ts
test('model forwards logical request diagnostics without forwarding session or credentials', async () => {
  const rows: unknown[] = [];
  const sink: Logger['debug'] = (a, b) => {
    rows.push([a, b]);
  };
  const logger: Logger = { debug: sink, info: sink, warn: sink, error: sink, child: () => logger };
  const { transport } = makeTransport();
  const model = createCursorLanguageModel('composer-2', {
    ...runtimeWith(transport, new CursorSessionStore()),
    logger,
  });
  const options = callOptions();
  const { stream } = await model.doStream(options);
  await lastPartType(stream);
  const serialized = JSON.stringify(rows);
  expect(serialized).toContain('"requestId":"r1"');
  expect(serialized).not.toContain('sha256:abc');
  expect(serialized).not.toContain('"refreshToken"');
  expect(serialized).not.toContain('"accessToken"');
});
```

driver 日志测试另将 query 中输入设为含 URL/路径的文本，工具 args 设为带 SECRET_TOOL_ARGS 的对象，终止前只观测安全计数；断言 serialized 不包含这些哨兵。对字段投影，传入 providerId='user@example.com'，断言邮箱未被记录。

```sh
rtk proxy bun test packages/plugins/cursor/src/runtime/driver packages/plugins/cursor/src/runtime/cursor-model packages/plugins/cursor/src/plugin
rtk proxy bun run --cwd packages/plugins/cursor test:unit
rtk proxy git diff --check
rtk proxy git add packages/plugins/cursor/src/plugin/plugin.ts packages/plugins/cursor/src/runtime/runtime.ts packages/plugins/cursor/src/runtime/provider/provider.ts packages/plugins/cursor/src/runtime/cursor-model packages/plugins/cursor/src/runtime/driver
rtk proxy git commit -m "fix(cursor): add safe run phase diagnostics" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 7: 验证真实 Responses 输出并整理交付

**Files:**

- Create: packages/core/src/egress/openai-responses/cursor-regression/cursor-regression.test.ts
- Reuse test-only: packages/plugins/cursor/src/runtime/cursor-model/test-support.ts（Task 5 已实现）
- Modify: .changeset/loose-cars-hunt.md
- Modify: docs/research/2026-09-07-cursor-proxy-comparison.md（追加实际实施后的验证记录）
- Review only: 本 spec/plan、既有 docs/research/2026-09-07-cursor-oauth-tool-continuation.md

**Interfaces:**

- Consumes: createCursorLanguageModel(modelId, CursorModelRuntime)、CursorSessionStore；Task 5 createProtocolFixture/protocolServerFrame/protocolUpdateFrame。
- Consumes: streamAiSdkText({ model, messages, settings, tools }).fullStream；writeOpenAIResponsesSSE(fullStream, { modelId })，返回带 completion 的 ReadableStream。
- Produces: 离线真实协议回归；不改 egress 实现、不增加跨包生产依赖，不用手工拼装 TextStreamPart 代替真实 mapper。

- [ ] **Step 1: 写覆盖参数、并行工具与第二轮结果的真实链路测试。**

cursor-regression.test.ts 的完整主体如下。工具只有 schema，没有 execute；不存在真实工具执行或网络访问。

```ts
import { expect, test } from 'bun:test';
import type { CredentialPort } from '@aio-proxy/plugin-sdk';
import type { CursorCredential } from '../../../../../plugins/cursor/src/schema';
import { createCursorLanguageModel } from '../../../../../plugins/cursor/src/runtime/cursor-model';
import {
  createProtocolFixture,
  protocolServerFrame,
  protocolUpdateFrame,
} from '../../../../../plugins/cursor/src/runtime/cursor-model/test-support';
import { CursorSessionStore } from '../../../../../plugins/cursor/src/store/session-store';
import { jsonSchema, streamAiSdkText, type ModelMessage } from '../../../ai-sdk-bridge';
import { writeOpenAIResponsesSSE } from '../index';

const credentials: CredentialPort<CursorCredential> = {
  read: async () => ({
    value: {
      accessToken: 'test',
      refreshToken: 'test',
      expiresAt: Number.MAX_SAFE_INTEGER,
      subject: 'test-account',
    },
    revision: 0,
  }),
  refresh: async () => {
    throw new Error('unexpected refresh');
  },
};

type OutputCall = { id: string; type: string; call_id: string; name: string; arguments: string };
type Event = {
  type: string;
  item_id?: string;
  delta?: string;
  arguments?: string;
  item?: OutputCall;
  response?: { output: OutputCall[] };
};

test('Cursor MCP inputs survive the actual AI SDK and Responses SSE in both turns', async () => {
  const argsBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const toolUpdate = (event: string, id: string, args: Record<string, Uint8Array>, delta?: string) =>
    protocolUpdateFrame({
      case: event,
      value: {
        callId: 'outer-' + id,
        ...(delta === undefined ? {} : { argsTextDelta: delta }),
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: { name: 'search', toolName: 'search', toolCallId: 'nested-' + id, args },
            },
          },
        },
      },
    });
  const f = createProtocolFixture([
    [
      toolUpdate('toolCallStarted', 'a', {}),
      toolUpdate('partialToolCall', 'a', {}, '{"query":"alpha","limit":6,"filters":{"lang":"ts"}}'),
      toolUpdate('toolCallCompleted', 'a', { query: argsBytes('alpha'), filters: argsBytes('degraded') }),
      toolUpdate('toolCallStarted', 'b', {}),
      protocolServerFrame({
        case: 'execServerMessage',
        value: {
          id: 2,
          execId: 'exec-b',
          message: {
            case: 'mcpArgs',
            value: {
              name: 'search',
              toolName: 'search',
              toolCallId: 'nested-b',
              args: { query: argsBytes('beta') },
            },
          },
        },
      }),
      // 第一轮没有 checkpoint、turnEnded、END_STREAM；由完整批次交接结束。
    ],
    [
      protocolUpdateFrame({ case: 'textDelta', value: { text: 'Both results received.' } }),
      { flags: 2, payload: new TextEncoder().encode('{}') },
      // 第二轮 HTTP 保持打开；Connect 成功本身应完成响应。
    ],
  ]);
  const model = createCursorLanguageModel('composer-2', {
    credentials,
    transport: f.transport,
    sessionStore: new CursorSessionStore(),
    model: { wireModelId: 'composer-2', displayModelId: 'composer-2', displayName: 'Composer 2', maxMode: false },
  });
  const tools = {
    search: {
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' }, filters: { type: 'object' } },
        required: ['query'],
      }),
    },
  };
  const responses = async (messages: ModelMessage[]): Promise<Event[]> => {
    const { fullStream } = streamAiSdkText({
      model,
      messages,
      tools,
      settings: {
        maxRetries: 0,
        providerOptions: {
          aioProxy: {
            logicalRequest: {
              requestId: 'integration-1',
              session: { key: 'sha256:integration', source: 'body-conversation' },
            },
          },
        },
      },
    });
    const sse = writeOpenAIResponsesSSE(fullStream, { modelId: 'composer-2' });
    const [body] = await Promise.all([new Response(sse).text(), sse.completion]);
    return body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as Event);
  };
  const user: ModelMessage = { role: 'user', content: 'Compare alpha and beta.' };
  const first = await responses([user]);
  expect(first.filter((e) => e.type === 'response.completed')).toHaveLength(1);
  expect(first.some((e) => e.type === 'response.failed')).toBe(false);
  const output = first
    .find((e) => e.type === 'response.completed')!
    .response!.output.filter((item) => item.type === 'function_call');
  expect(output.map((c) => c.call_id)).toEqual(['outer-a', 'outer-b']);
  expect(output.map((c) => JSON.parse(c.arguments))).toEqual([
    { query: 'alpha', limit: 6, filters: { lang: 'ts' } },
    { query: 'beta' },
  ]);
  for (const call of output) {
    const delta = first.filter((e) => e.type === 'response.function_call_arguments.delta' && e.item_id === call.id);
    const done = first.filter((e) => e.type === 'response.function_call_arguments.done' && e.item_id === call.id);
    const itemDone = first.filter((e) => e.type === 'response.output_item.done' && e.item?.id === call.id);
    expect(delta).toHaveLength(1);
    expect(delta.map((e) => e.delta).join('')).toBe(call.arguments);
    expect(done).toHaveLength(1);
    expect(done[0]!.arguments).toBe(call.arguments);
    expect(itemDone).toHaveLength(1);
    expect(itemDone[0]!.item!.arguments).toBe(call.arguments);
  }
  const second = await responses([
    user,
    {
      role: 'assistant',
      content: output.map((call) => ({
        type: 'tool-call',
        toolCallId: call.call_id,
        toolName: call.name,
        input: JSON.parse(call.arguments),
      })),
    },
    {
      role: 'tool',
      content: output.map((call, i) => ({
        type: 'tool-result',
        toolCallId: call.call_id,
        toolName: call.name,
        output: { type: 'text', value: i === 0 ? 'RESULT_A' : 'RESULT_B' },
      })),
    },
  ]);
  expect(second.filter((e) => e.type === 'response.completed')).toHaveLength(1);
  const root = f.roots[1]!.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const calls = root.filter((p) => p.type === 'tool-call');
  const results = root.filter((p) => p.type === 'tool-result');
  expect(calls.map((c) => c.args)).toEqual(output.map((c) => JSON.parse(c.arguments)));
  expect(results.map((r) => r.result)).toEqual(['RESULT_A', 'RESULT_B']);
  expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
  expect(f.runs).toHaveLength(2);
  expect(f.closes).toEqual([1, 1]);
});
```

- [ ] **Step 2: 运行集成回归，并把失败定位到实际层。**

```sh
rtk proxy bun test packages/core/src/egress/openai-responses/cursor-regression
```

该回归应在 Task 1–6 的最终实现上通过。若失败，保留真实 Cursor 输入和真实 egress；按失败断言检查 mapper 的四元事件、SDK 输出、SSE 或 root，不能用手写正常流替换有问题的中间层。

- [ ] **Step 3: 重写现有 changeset，检查旧说明没有残留。**

不创建第二份修复 changeset；前序未发布改动统一改写为最终用户行为：

```md
---
'aio-proxy': patch
'@aio-proxy/plugin-cursor': patch
---

Fix Cursor OAuth requests hanging on interaction or stream completion, losing tool arguments or sibling calls, and repeating tools because resumed context omitted their calls and results. Stalled runs now terminate with clearer diagnostics.
```

检查所有未发布说明；只修改涉及本次行为的旧文案：

```sh
rtk proxy rg -n 'Cursor|cursor|tool arguments|tool results' .changeset
rtk proxy git diff --check
```

本段措辞只覆盖已复现路径，不宣称所有模型、所有长等待都已解决。

- [ ] **Step 4: 运行受影响测试与仓库门禁，保存实际结果。**

```sh
rtk proxy bun run --cwd packages/plugins/cursor test:unit
rtk proxy bun run --cwd packages/core test:unit
rtk proxy bun run check
rtk proxy bun run preflight
```

preflight 实际还包含类型检查、各包构建/测试任务，不能简化成仅 lint。如果仍被未修改的 dashboard TS2322/TS2589 阻断，记录命令、错误位置及未继续执行的检查；确认 Cursor 和 core 测试与 check 独立通过，不修无关 dashboard 代码。

在跨项目调研报告末尾追加“实施验证”记录：填写本次实际执行时间、实施 commit、各命令退出状态、R1–R7 对应测试名、实际 smoke 结果/未执行原因。这里不预先写入 PASS，也不复用前序 215 个测试结果。

- [ ] **Step 5: 有现成有效访问凭证时做独立会话的只读工具 smoke。**

这是可选的真实上游验证，不需要为了计划交付登录或重启服务。只使用执行环境已有的 CURSOR_ACCESS_TOKEN，缺失时记录“未执行真实上游 smoke：没有可用测试凭证”。这是测试脚本的输入，未新增产品运行时设置；不得把 token 写入命令行、文档或日志。

在 /tmp/aio-cursor-reliability-smoke.ts 写入以下内容，从本工作区源码直接调用插件；不用正在运行的旧服务来验证新代码。模型 ID 使用已有 CURSOR_SMOKE_MODEL，缺省 composer-2：

```ts
const { createCursorLanguageModel } = await import(
  process.cwd() + '/packages/plugins/cursor/src/runtime/cursor-model/index.ts'
);
const { CursorSessionStore } = await import(
  process.cwd() + '/packages/plugins/cursor/src/store/session-store/index.ts'
);
const { createNodeHttp2Transport } = await import(
  process.cwd() + '/packages/plugins/cursor/src/wire/transport/index.ts'
);

const accessToken = Bun.env.CURSOR_ACCESS_TOKEN;
if (!accessToken) throw new Error('No test credential available.');
const modelId = Bun.env.CURSOR_SMOKE_MODEL || 'composer-2';
const model = createCursorLanguageModel(modelId, {
  credentials: {
    read: async () => ({
      value: {
        accessToken,
        refreshToken: 'unused',
        expiresAt: Number.MAX_SAFE_INTEGER,
        subject: 'isolated-smoke',
      },
      revision: 0,
    }),
    refresh: async () => {
      throw new Error('Refresh is disabled in this smoke.');
    },
  },
  sessionStore: new CursorSessionStore(),
  transport: createNodeHttp2Transport(),
  model: { wireModelId: modelId, displayModelId: modelId, displayName: modelId, maxMode: false },
});
const providerOptions = {
  aioProxy: {
    logicalRequest: {
      requestId: crypto.randomUUID(),
      session: { key: 'sha256:' + crypto.randomUUID(), source: 'body-conversation' },
    },
  },
};
const tools = [
  {
    type: 'function' as const,
    name: 'read_fixture',
    description: 'Read the fixed smoke-test fixture.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
];
const first = await model.doGenerate({
  providerOptions,
  tools,
  abortSignal: AbortSignal.timeout(60_000),
  prompt: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Call read_fixture once with key="probe". After receiving the result, reply with that result and do not call another tool.',
        },
      ],
    },
  ],
});
const calls = first.content.filter((p) => p.type === 'tool-call');
if (calls.length !== 1 || JSON.parse(calls[0]!.input).key !== 'probe') throw new Error('Unexpected smoke tool call.');
const second = await model.doGenerate({
  providerOptions,
  tools,
  abortSignal: AbortSignal.timeout(60_000),
  prompt: [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: calls[0]!.toolCallId,
          toolName: 'read_fixture',
          output: { type: 'text', value: 'FIXTURE_OK' },
        },
      ],
    },
  ],
});
if (second.content.some((p) => p.type === 'tool-call')) throw new Error('The model repeated the tool.');
if (!second.content.some((p) => p.type === 'text' && p.text.includes('FIXTURE_OK'))) {
  throw new Error('The final response did not contain the result.');
}
console.log('Cursor two-turn smoke passed.');
```

```sh
rtk proxy bun run /tmp/aio-cursor-reliability-smoke.ts
```

脚本只回传固定测试结果，不执行模型生成的 shell/文件操作；内存会话不影响用户缓存。上游失败或模型未遵循工具指令要单独记录，不能据此改写离线回归结果；一次通过也不代表所有模型通过。

- [ ] **Step 6: 核对 diff，提交集成回归与发布说明。**

```sh
rtk proxy git diff --stat
rtk proxy git diff --check
rtk proxy git status --short
rtk proxy git add packages/core/src/egress/openai-responses/cursor-regression .changeset/loose-cars-hunt.md docs/research/2026-09-07-cursor-proxy-comparison.md docs/research/2026-09-07-cursor-oauth-tool-continuation.md docs/superpowers/specs/2026-09-07-cursor-oauth-protocol-reliability-design.md docs/superpowers/plans/2026-09-07-cursor-oauth-protocol-reliability.md
rtk proxy git commit -m "test(cursor): cover Responses tool handoff and resume" -m "Co-authored-by: Codex <noreply@openai.com>"
```

只暂存确认属于本修复的报告。交付时说明实际通过项、既有阻断和 smoke 状态；实施不包含推送、合并、发布或服务重启。

## Spec 覆盖与执行顺序

| Spec 条款   | 实现任务 | 关键回归                                                         |
| ----------- | -------- | ---------------------------------------------------------------- |
| C1 / R1     | 1        | query ID、批准/拒绝/error、未知交互失败                          |
| C2 / R5     | 1        | wire field 7、probe 后同 ID 真调用                               |
| C3 / R3、R6 | 2        | 早到 snapshot、空 completion 后 exec、身份别名、完整对象输入     |
| C4 / R2     | 3        | 连续/交错兄弟调用、重复不延长、四元事件一次                      |
| C5 / R4     | 4        | END_STREAM 不等待 EOF、turnEnded 固定收尾、trailer 错误          |
| C6 / R7     | 5        | root args/result、特殊 ID、全量/增量、无 checkpoint、部分结果    |
| C7          | 4        | 首帧/静默/心跳无进展的独立假时钟测试                             |
| C8          | 6        | PluginApi logger 透传、allowlist、不泄露、sink 失败不影响生成    |
| C9          | 7        | 真实 SDK/Responses delta、done、最终 output 一致，两个工具都输出 |
| C10         | 4、5     | cancel/迟到句柄、唯一终态、失败不写缓存、原 affinity/CAS 保留    |
| 发布与验收  | 7        | 现有 changeset 重写、插件/core 检查、真实 smoke 单独标记         |

执行顺序为 1 → 2 → 3 → 4 → 5 → 6 → 7。每个任务按失败回归、实现、通过验证、检查 diff、提交推进；遇到与 spec 冲突的真实协议证据，先修订这两份文档再修改受影响行为。前序源码补丁已单独提交为实施基线；本计划的七项扩展修复仍待完成。

文档自审：已核对 C1–C10 覆盖、生产/测试文件职责、跨任务类型与 helper 名称、可执行命令及无占位步骤。所有未勾选框表示尚未实施，不表示设计待定。
