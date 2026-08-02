# Spec：provider `metadata` 字段全貌（v2 — 决策已收敛，待最终确认）

> 原则：以 models.dev 为基底、OpenRouter 为参照，可再拓展；`.loose()` 保留未知字段只 warn；命名统一 **camelCase**。

## 0. 权威字段来源（实拉，非记忆）

**models.dev**（`@opencode-ai/models@0.0.11` 的 `Model`）：
- `limit: { context(必), input?, output? }`
- `cost: { input, output, reasoning?, cache_read?, cache_write?, input_audio?, output_audio?, context_over_200k?, tiers?: Array<Cost & { tier:{ type:'context', size } }> }`
- 能力位：`attachment? reasoning? reasoning_options? tool_call? structured_output? temperature? knowledge? modalities{input[],output[]} open_weights? status?`

**OpenRouter**（实拉 `/api/v1/models` 的 `pricing`，全 catalog 出现过的键）：
`prompt, completion, image, image_output, audio, audio_output, input_audio_cache, web_search, request, internal_reasoning, input_cache_read, input_cache_write, input_cache_write_1h, overrides`
- 例（`google/gemini-3.6-flash`）：`prompt / completion / image / audio / audio_output? / input_audio_cache / web_search / internal_reasoning / input_cache_read / input_cache_write`

**结论（audio 那一问）**：models.dev **和** OpenRouter **都把 audio 拆成 input/output 两个**。我原来的单个 `audio` 是异类 → 采纳"拆分"。

## 1. 已确认决策

| 点 | 结论 |
|----|------|
| audio | **拆分**为 `inputAudio` / `outputAudio`（两家都这么做） |
| tiers | **照抄 models.dev** 嵌套结构：`{ tier: { type: 'context', size }, ...价格 }` |
| 能力位 | **v1 就加**（reasoning / temperature / toolCall / attachment / structuredOutput / modalities） |
| price→cost | 已改名 `cost` |
| contextWindow→limit | 已改为 `limit.{context,input,output}` |
| 命名 | camelCase；`.loose()` 兜底 |

## 2. 完整 config `metadata` 字段（最终提案）

```jsonc
"metadata": {
  "<upstream-model-id>": {
    // ── 展示 / 继承 ──
    "displayName": "GPT-5 Codex",
    "description": "OpenAI GPT-5 tuned for agentic coding",  // 对齐 models.dev：description 是模型顶层字段，不归 capabilities
    "extend": "openai/gpt-5",           // 仅当本地 id 与 models.dev slug 对不上时改指向

    // ── 硬能力 limit（全可选，覆盖语义）──
    "limit": { "context": 400000, "input": 272000, "output": 128000 },

    // ── 能力位 capabilities（v1 纳入；全可选、覆盖 models.dev 自动发现；扁平布尔支持三态：true=强制开 / false=强制关 / 缺省=不覆盖）──
    "capabilities": {
      "reasoning": true,
      "temperature": true,
      "toolCall": true,
      "attachment": true,
      "structuredOutput": true,
      "modalities": { "input": ["text","image"], "output": ["text"] },
      // 日期元数据（YYYY-MM 或 YYYY-MM-DD）
      "knowledge": "2025-01",
      "releaseDate": "2025-06",
      "lastUpdated": "2025-07"
    },

    // ── 计费 cost（USD / 百万 token；per-event 为 USD/次）──
    "cost": {
      "input": 1.25, "output": 10,
      "reasoning": 10,
      "cacheRead": 0.125, "cacheWrite": 1.25,
      "inputAudio": 40, "outputAudio": 80,     // ← 拆分，对齐两家
      "image": 0.01,                            // 拓展：USD/张
      "webSearch": 0.03,                        // 拓展：USD/次
      "request": 0.004,                         // 拓展：USD/请求
      "tiers": [                                // 照抄 models.dev 嵌套
        { "tier": { "type": "context", "size": 200000 },
          "input": 2.5, "output": 15 }
      ]
    }
  }
}
```

## 3. 最终 zod schema 形状

```ts
ModalitySchema = z.enum(['text','audio','image','video','pdf'])

ModelCapabilitiesSchema = z.object({
  reasoning?, temperature?, toolCall?, attachment?, structuredOutput?: z.boolean(),
  modalities?: z.object({ input?: Modality[], output?: Modality[] }).loose(),
  knowledge?, releaseDate?, lastUpdated?: z.string(),   // 日期元数据 YYYY-MM(-DD)
}).loose()

ModelLimitSchema = z.object({ context?, input?, output?: int().positive() }).loose()

TierClassFields = { input?, output?, reasoning?, cacheRead?, cacheWrite?,
                    inputAudio?, outputAudio? : USD/1M }
ModelCostTierSchema = z.object({
  tier: z.object({ type: z.literal('context'), size: int().nonnegative() }),
  ...TierClassFields,
})
ModelCostSchema = z.object({
  ...TierClassFields,
  image?, webSearch?, request?,        // per-event 拓展
  tiers?: ModelCostTierSchema[],
}).loose()

ModelMetadataSchema = z.object({ displayName?, description?, extend?, limit?, capabilities?, cost? }).loose()
```

## 4. 计费引擎需要跟着改的点（`usage-pricing.ts`）

- `OpenRouterModelPrice`/`OpenRouterModelPriceTier`：`audio` → `inputAudio`/`outputAudio`；tier 的 `threshold` → 读 `tier.size`。
- `configModelPrice`：`audio` 映射拆分；tiers 从 `{ tier:{size}, ... }` 读 size 映射为内部 `threshold`（内部引擎仍可用 threshold 表示，只是 config 侧结构照抄 models.dev）。
- `calculateEstimatedCost`：`addTokens(usage.audioTokens, price.audio)` → 拆成 input/output 两条（需 `UsagePricingInput` 增 `outputAudioTokens`）。
- `tierAdjustedPrice`：选档改用 `tier.size` 阈值（语义：按 context/input token 超过 size 触发——沿用现有 `usage.inputTokens > size`）。

## 5. 能力位下游投影（v1 就加的代价）

- `RuntimeModelMetadata` 已是 `ModelMetadata & {protocol?}`，capabilities 自动带上。
- `/models`（`list-models.ts`）与 codex（`codex-assembly.ts`）需把 capabilities 覆盖投影到对外字段——需确认 Codex ModelInfo 消费哪些能力位（reasoning/tool 等），未消费的仅存储不投影。
- 未消费的能力位仍值得存，因为 dashboard 与未来导出器会用。

## 6. 最终确认（已定）

capabilities = **行为能力 + 日期元数据**。即在行为布尔位/modalities 之外，再加日期类展示元数据：

```ts
ModelCapabilitiesSchema = z.object({
  // 行为能力（布尔）
  reasoning: z.boolean().optional(),
  temperature: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  attachment: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  modalities: z.object({
    input: z.array(ModalitySchema).optional(),
    output: z.array(ModalitySchema).optional(),
  }).loose().optional(),
  // 日期元数据（YYYY-MM 或 YYYY-MM-DD 字符串；仅存储/展示）
  knowledge: z.string().optional(),      // knowledge cutoff
  releaseDate: z.string().optional(),
  lastUpdated: z.string().optional(),
}).loose()
```

`MODEL_METADATA_KNOWN_KEYS` = `{ displayName, description, extend, limit, capabilities, cost }`。
`capabilities`/`limit`/`cost` 的未知子键沿用 `.loose()` 兜底；`collectUnknownModelMetadataKeys` 现仅检查顶层 + `cost` 子键（保持现有粒度，capabilities/limit 子键不额外收集）。

### 6.1 能力位风格：为什么是扁平布尔而非 OpenRouter 的 `supported_parameters`

对比过两家的真实数据（2026-08 live）：

- **models.dev `Model`**：扁平布尔 `attachment/reasoning/tool_call/structured_output/temperature`，顶层 `description`，日期 `knowledge/release_date/last_updated`，`modalities{input[],output[]}`。
- **OpenRouter `/api/v1/models`**：能力塞进 `supported_parameters: string[]`（`tools/tool_choice/structured_outputs/response_format/temperature/reasoning/web_search_options` 等，混入 25+ 采样参数如 `min_p/top_a`）；modalities 在 `architecture{}` 下；日期用 `knowledge_cutoff/expiration_date`；`reasoning` 是富对象 `{mandatory,default_enabled,supported_efforts[],default_effort}`。

选扁平布尔的理由（覆盖场景）：

1. **三态覆盖**：布尔能表达 `true`(强制开)/`false`(强制关)/缺省(不覆盖)。数组只能表达"存在=支持"，**无法表达强制关闭**——对覆盖 models.dev 误报值是致命缺陷。
2. **值域受控**：布尔位是自解释的能力集；`supported_parameters` 值域混杂、需枚举 25+ 值或放任 `.loose()` 乱写。
3. **对齐权威源**：models.dev 本身用扁平布尔；OpenRouter 仅作为 modalities 取值与"audio 拆分"的佐证。
4. **"字段更少"是错觉**：数组把 N 个布尔压成 1 字段，代价是每个消费点 `includes('tools')` 字符串查找且丢失三态。

`description` 依两家惯例置于 **metadata 顶层**（与 `displayName` 平级），不归入 `capabilities`。`reasoning` 保持 `boolean`——"如何配置 reasoning"（effort/budget）属路由层，v1 不引入。
