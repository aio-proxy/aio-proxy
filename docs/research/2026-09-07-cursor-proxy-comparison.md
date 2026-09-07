# Cursor 反代实现调研与 aio-proxy 对照

调研日期：2026-09-07。对照对象为本工作区的 Cursor OAuth 插件：基线提交 `739892883470482806a8663f664096a6422ef4a0`，加上前序参数流、工具结果续接补丁（现已作为 ae32d4fef4ee910449e433943835aaec31b2ba2a 随本 PR 提交）。它不代表线上已部署版本。

## 结论

目前最需要补齐的是 **Cursor Agent 协议的请求、工具与结束状态处理**。已有证据支持这是跨客户端、跨模型都可能出问题的公共链路；不能据此断定所有模型、所有长等待都出于同一个原因。

最适合参考我们现有架构的是 **OpenCodex**，其次是 **OMP**。OpenCodex 同样会在把工具调用交给外部客户端后取消上游 Run，再用下一次请求续接；它证明这条架构可以继续完善，无须先改成长连接会话。OMP 更值得参考协议语义、参数合并和历史消息配对，但它能在宿主里直接执行工具，与通用反代的约束不同。

本次对照发现并通过离线帧回放确认了 **7 个具体缺口**，包括：需要回答的交互请求无人回答、审批探测被输出为可执行工具调用、后续工具帧被提前截断、迟到参数变成空对象、提前到达的参数快照丢失、协议已结束仍等待 HTTP EOF，以及重建历史丢失调用与结果的结构化关联。前序两个补丁解决了真实案例中的部分问题，尚未覆盖这些情况。

外层已经有 **300 秒流空闲超时**，不能说我们完全没有超时。问题是 Cursor 内部缺少首帧、断联、只有心跳、工具等待、协议结束等阶段判断；单纯把 300 秒缩短，无法修复漏回包、漏工具和上下文缺失。

## 证据边界

本次区分三种证据：

- **真实请求与日志**：原 Codex 任务 `01a07afc-4b65-70c0-8bd4-11f20f94a4af` 存在空工具参数、工具报错和约 260–270 秒后取消的请求。前序独立 Composer 2.5 双轮测试在修补参数流与续接提示词后，约 2.83 秒发起工具调用，收到结果后约 4.42 秒回答 `OK`。
- **当前代码的确定性回放**：本次使用真实 driver、protobuf 编解码、参数 mapper 和请求构造器，注入合成上游帧，验证下表 7 条路径。没有连接 Cursor，没有执行客户端工具。
- **参考项目源码与测试**：核对具体实现和固定提交；没有对 7 个项目做同账号、同模型、同提示词的性能压测，不能给出可靠速度排名。项目 README 的压力测试数字也不是本次实测。

原任务没有保存 Cursor 原始协议帧，无法逐一判断那几次长等待触发了哪条路径。前序成功测试里 `turnEnded → EOF` 只有约 7 ms；本次回放另行证明，如果服务器保持 HTTP 流打开，我们确实无法按协议结束信号及时收尾。这两项观察并不冲突。

前序排查与验证见 [Cursor OAuth 工具调用与续接排查](2026-09-07-cursor-oauth-tool-continuation.md)。

## 参考项目与取舍

以下比较的是具体实现路径。部分项目还有其他后端；API Key、OAuth 凭证、客户端协议也不完全相同，不能视为可直接替换的插件。

| 项目、核对提交                                       | 本次研究的路径                                                   | 最值得参考的部分                                                           | 明确限制                                                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenCodex][opencodex] · `ec51e42d745d`              | Cursor Agent Run；Responses 客户端工具采用取消、重建续接         | 工具事件顺序、延迟收尾、交互回包、首帧与无进展检测、协议终止；与我们最接近 | 也有经验性等待窗口；完成参数非空时整包覆盖缓冲，不能照搬该合并规则                                                                     |
| [OMP / oh-my-pi][omp] · `3e181fe0cb73`               | Cursor provider 直接驱动 Agent Run；宿主可执行工具并写回真实结果 | 完成参数与流快照合并、内外 call ID 关联、结构化工具历史、审批探测语义      | 宿主内执行和外部工具交接是两条路径；部分交互默认策略也不适合通用反代                                                                   |
| [offbynan/pi-cursor-provider][pi] · `a89ac0ff34d1`   | pi provider / proxy + Node H2 bridge；保留上游会话回填工具结果   | 实际 HTTP/2 PING/ACK、首帧和活动检测、工具结果回到原 Run                   | 是 ndraiman 项目的衍生实现；所读 dispatcher 同样未处理 interactionQuery；stall 计时被任何帧重置，工具结果还有固定 isError=false 的路径 |
| [OmniRoute][omni] · `aa912c42a7d5`                   | 多供应商反代的 Cursor H2 路径；内存会话池 + 冷启动回退           | pending exec ID 配对、运行/等待工具/关闭状态、连接存活时原地续接           | 会话驻留单实例，跨实例或失效时仍重建；冷路径会扁平化历史，所读回填路径也固定传入 false 错误标记                                        |
| [7iook/cursor-bridge][bridge] · `03187f574e2f`       | Anthropic API → Cursor Run；保留上游流                           | 完整工具批次归属校验、先校验再写回、断线恢复时限定范围的结果重放           | 专门服务其客户端协议，README 明确尚未 production ready；长期稳定性数据属作者报告                                                       |
| [greenSheep999/cursor-proto][proto] · `193173315486` | 本次重点看原生 Go RunSSE + BidiAppend；仓库另有 SDK 路径         | 独立协议/schema 对照、交互回复、turnEnded 后有界等待                       | 所读路径只回应特定 web 查询；README 的“无逐 token 输出”结论限其路径与版本，不能外推到我们的 Run                                        |
| [NGLSG/Cursor2API][c2a] · `d3adc7e59ce5`             | Cursor API Key + SDK 本地 bridge，外层输出 OpenAI/Responses      | Responses 工具参数 delta/done 事件、同 agent 请求串行化、无输出时有限重试  | 第一个可转发工具调用就取消 SDK Run，返回单个调用；工具回调会返回占位字符串。SDK 没有自动解决外部工具续接问题                           |

**选型建议：OpenCodex 做主要行为对照，OMP 做协议语义对照，cursor-bridge 做会话与恢复约束对照。** pi-cursor-provider、OmniRoute 适合研究长连接方案；cursor-proto 适合交叉核验协议；Cursor2API 适合核验客户端 Responses 输出契约。

## 当前实现的 7 条回放结果

回放基线包含前序两个补丁。表中“结果”是当前代码实际产生的行为，不是期望通过的修复验收结果。

| 编号 | 合成输入 / 检查点                                                                    | 当前结果                                                                                    | 可能影响与参考                                                                                                |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R1   | `interactionQuery(webSearchRequestQuery, id=41)`，保持流打开，确认 driver 已读过此帧 | 输出 0 个 interactionResponse                                                               | 上游若等待同 ID 回复，会持续停住。OpenCodex / OMP 有专门处理                                                  |
| R2   | 连续两个 `execServerMessage.mcpArgs`：call-a、call-b                                 | 只消费第 1 帧、只输出 call-a，然后 end/close                                                | 首个工具完成时，本地集合为空不代表同批工具已全部到达。OpenCodex 使用可撤销的收尾窗口                          |
| R3   | started 空参数 → completed 空参数 → 同 ID 的 mcpArgs 带完整 query                    | 第 2 帧后输出 `{}` 并关闭，未读取第 3 帧                                                    | 前序参数流补丁仍可能输出错误空参数。OpenCodex 有等待后续原生参数的状态                                        |
| R4   | text=OK → turnEnded → 成功 Connect END_STREAM，HTTP body 继续打开                    | EOF 前无 finish；释放 EOF 后才有 finish                                                     | 模型已完成但客户端仍等待。OpenCodex 将成功协议结束作为终止信号，turnEnded 后也有有限收尾                      |
| R5   | 正常 McpArgs 附带 field 7=true，即 OMP 当前 schema 中的 smart_mode_approval_only     | 输出客户端可执行的 approval-probe tool-call；0 个 exec 回复                                 | 审批探测与执行混淆。这里只记录了事件，未执行任何工具；OMP 在该分支只回复 approved/rejected                    |
| R6   | partialToolCall 快照含 query、limit，先于 started；completed 仅含 query              | 最终参数只剩 query，丢失 limit=6                                                            | 完成帧不能总补齐早到快照。OpenCodex 能从带工具信息的 partial 建立状态；OMP 的合并规则能保留已经缓存的省略字段 |
| R7   | 历史含两个 assistant tool-call，参数 alpha/beta，及对应 RESULT_A/B                   | root 消息角色为 system/user/user/user；无 assistant/tool 结构，也无 toolCallId 和原调用参数 | 文本可见不等于工具关联完整，复杂续接可能需要重新推断。OMP 保留 assistant 调用与 role=tool 配对结果            |

上述结果来自调研时的临时合成帧脚本，不是纳入 CI 的正式回归测试。跨机器实施不依赖该临时文件；配套 plan 已给出 R1–R7 的正式回归代码与夹具，验收必须断言修复后的行为。

R5 使用已核对的 OMP protobuf 字段编号，在合成 McpArgs 尾部附加 `0x38 0x01` 后交给我们的真实 protobuf decoder。它验证的是“较新消息进入当前 schema/driver 时的行为”，不表示原任务已经观察到这种消息。

## 能力逐项对照

| 能力             | aio-proxy 当前状态                                                                                | 可吸收的实现与注意事项                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 参数进入客户端流 | 前序补丁已把最终完整参数送入 tool-input-delta，保留被完成帧省略的缓存字段                         | 保留该补丁；补早到快照、重复 start、空 completion 和迟到 mcpArgs 的状态约束。参考 [OpenCodex mapper][ocx-mapper] 与 [OMP 合并][omp-args]          |
| 工具批次边界     | 有已完成/未完成集合，但集合首次清空就关闭 Run                                                     | 参考 [OpenCodex 可撤销 finalize][ocx-finalize]；新工具事件必须撤销待执行的收尾，窗口触发时重新检查状态                                            |
| 交互请求         | driver 分派中没有 interactionQuery                                                                | 参考 [OpenCodex 回包][ocx-query] 和 [OMP query 模块][omp-query]；按实际能力回应或明确拒绝，未知类型应可诊断，不能静默等待                         |
| 审批探测         | 当前 McpArgs schema 只有字段 1–5，driver 把所有 mcpArgs 当工具执行请求                            | 对齐 [OMP schema][omp-schema] 与 [审批处理][omp-approval]；探测不能形成 executable tool-call，不能因是未知字段就按普通调用处理                    |
| 工具结果历史     | 已修复 root 提示词未更新，但重建时调用被丢弃，结果变为 user 文本                                  | 参考 [OMP 结构化历史][omp-history]；保存调用 ID、工具名称、输入、输出和错误/拒绝/空结果语义                                                       |
| Run 与 HTTP 结束 | 普通文本路径等待 EOF、trailers 后才发 finish                                                      | 参考 [OpenCodex END_STREAM][ocx-end]；分别处理正常协议结束、上游错误、未完整工具和网络 EOF，确保只终止一次                                        |
| 首帧与进展检测   | Cursor driver 每 5 秒发应用心跳；外层 300 秒 SDK 流空闲超时                                       | 参考 [OpenCodex 双时钟][ocx-health]：连接存活和模型进展分别记录。HTTP/2 PING 参考 [pi bridge][pi-ping]，它不等于模型有进展                        |
| 会话连续性       | 每轮新建 H2 Run，工具交接后关闭；缓存 protobuf 状态、blob、pending ID                             | [OmniRoute][omni-resume] / [pi][pi-resume] 保持 Run 活着可减少重建；应先量化收益，不能把“持有连接”当作协议正确性的替代                            |
| 会话隔离与并发   | 有账户 + logicalSessionKey、Provider affinity/revision 检查和缓存比较写入；没有同会话请求串行执行 | 保留现有隔离。参考 [cursor-bridge 批次校验][bridge-session] 与 [Cursor2API 请求串行化][c2a-queue]；比较写入只保护缓存覆盖，不串行化正在运行的请求 |
| 失败恢复         | 本次未对全部重试路径做独立回放；外层已有统一候选循环                                              | 借鉴“输出/工具副作用后不可透明重试”的边界。参考 [OpenCodex 副作用标记][ocx-query]、[cursor-bridge 恢复账本][bridge-replay]；不要再加独立候选循环  |
| 客户端事件契约   | 通过 AI SDK 统一转为 Responses 等协议；前序已经回放验证参数 delta → response.completed            | [Cursor2API][c2a-events] 明确发 arguments.delta/done，可作交叉验收；不要在 Cursor 插件里另造一套 Responses 输出层                                 |
| 用量与诊断       | Cursor 输出 tokenDelta 可计量，输入 token 当前未知；通用 trace 难解释 Cursor 内部等待阶段         | OpenCodex 对 checkpoint 的累计 context tokens 与输出增量分别处理；不能把累计上下文直接当单次输入用量                                              |

### 超时应如何理解

[当前通用空闲检查](../../packages/server/src/usage-capture/stream-capture.ts#L63) 在等待读取 SDK 输出时启动，避免把下游背压算成上游卡住。这是应保留的行为。

但这个层级看不到原始 Cursor 心跳、KV 往返或待答 query。Cursor 可能完全断联，也可能仅发心跳，也可能正在搬运上下文，也可能停在我们没有回复的消息上；客户端都只能看到暂时没有有效输出。

OpenCodex 的默认值是：首帧 30 秒、帧静默 30 秒、只有存活帧而无进展 90 秒、turnEnded 后 500 ms 收尾；pi bridge 的首帧/活动检测是 120/300 秒，另有每 15 秒 PING、10 秒 ACK 期限。数值差异很大，说明需要学习的是 **分阶段计时与明确终止原因**，不能凭参考项目数字直接确定我们的超时。

长思考、工具执行、工具等待以及 KV 阶段需要不同语义。活跃的本地工具工作也不能与“只有心跳”混为一谈。完整工具调用已交给客户端时，应及时结束本次客户端响应；若未来保留上游 Run，则由独立的等待工具结果状态管理它。

### 为什么暂不建议先改成持有 Run

现在的基本路径是：

`Run A → 收到工具调用 → 返回客户端并关闭 A → 收到工具结果 → 用历史/状态发 Run B`

长连接方案是：

`Run A → 收到工具调用 → 返回客户端并保留 A → 收到工具结果 → 用 exec ID 写回 A → A 继续生成`

后者能避免一部分建连与上下文重建，但本次没有测量其延迟收益。它同时要求：

- 从完整 pending 工具批次确认唯一会话归属，验证完毕再写入，不能半批已经写回才发现另一半不匹配。
- 驻留期间继续读取/排队消息，处理心跳、token 失效、取消、TTL、连接池上限和背压。
- 同会话并发有明确策略；进程重启、跨实例、连接死亡时能回退，并避免恢复时重复执行已经完成的工具。

[cursor-bridge][bridge-session] 对混合会话、重复 ID、未知 ID、不完整批次的校验比“命中一个 ID 就续接”更明确。其 [replay ledger][bridge-replay] 只在恢复请求启用、只覆盖本次恢复的结果批次、每条消费一次，避免把后续合法的同名同参调用永久替换成旧结果。

这些约束值得研究，但不应直接变成通用的“按工具名与参数去重”。历史上相同的读文件、搜索请求，完全可能需要再次执行。

OpenCodex 已经在取消/重建架构中处理了我们多项缺口，因此先把当前路径做正确，改动范围和验证目标都更明确。

## 建议的修复顺序

| 顺序     | 工作范围                                                                         | 最小验收                                                                                                             |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1        | 补齐 interactionQuery 回应与审批探测语义，核对实际使用的 protobuf schema         | 需要回应的 query 有匹配 ID 的结果；不支持的请求明确失败/拒绝；approval-only 不产生可执行工具事件                     |
| 2        | 完善工具调用状态：提前快照、空完成事件、迟到完整参数、同批后续工具、内外 ID 关联 | R2/R3/R6 转成正式回归；另验重复事件、真实无参数工具、工具间交错、畸形 JSON，不靠一律等待或一律填空对象               |
| 3        | 恢复结构化工具历史，保持当前 root 更新补丁                                       | 两个同名不同参数工具的结果保持准确配对；完整历史与增量结果两种续接都覆盖成功、失败、拒绝和空结果                     |
| 4        | 明确协议终止与分阶段停滞检测                                                     | 成功 END_STREAM 无需 HTTP EOF 才结束；turnEnded 有有限收尾；残缺工具和上游错误不能伪装成功；只有心跳最终给出明确原因 |
| 同步     | 增加阶段诊断，沿用现有统一流水线和 trace                                         | 能从一条 trace 判断等在哪里，不依赖记录完整提示词或 token                                                            |
| 后续评估 | 用同账号同模型 A/B 决定是否保留活 Run                                            | 比较首字、工具交接、结果后续接、重复调用率、超时率及连接/内存成本；通过并发与断线恢复测试后再决定                    |

工具批次的等待窗口是一个兼容性机制，不能证明未来再无工具帧。实现应优先依据已知协议状态，并保留有界等待、迟到帧诊断和超时行为。OpenCodex 的默认 50 ms finalize grace 及对特定提示词扩展窗口的启发式，也不能直接成为我们的公共语义。

推荐记录的字段包括：发出 Run、收到首帧、首次文本、工具参数就绪、工具交接、待答 query、最后存活帧、最后进展帧、turnEnded、Connect END_STREAM、HTTP EOF 的时间；附带模型、Provider ID、重建/续接方式、待处理工具数量和终止原因。原始内容捕获应是按需的独立诊断能力，默认事件元数据已足够定位很多问题。

本次建议修复的重点仍在 Cursor 插件。已有统一候选循环、跨协议 egress、账户身份隔离、Provider affinity 检查和有大小上限的会话缓存应继续保留，不需要为了参考项目而迁移整套架构。

## 验证与交付状态

- 本次文档完成后，`bun run check` 和 `git diff --check` 通过；lint 报告了未修改文件中的既有警告。文档引用定义及 11 个本地链接的存在检查通过。
- 本次 7 个离线探针全部重现上表当前行为；其中断言通过代表缺口得到确认，不代表这些缺口已经修复。
- 尝试运行 OpenCodex 的工具收尾、交互请求、流健康、EOF 终止四组测试，但参考仓库缺少 `@bufbuild/protobuf`，在加载阶段失败；没有执行其中的测试断言，也没有安装依赖。
- 前序已完成的验证：Cursor 插件 215 个测试、`bun run check`、插件范围类型检查和一次真实 Composer 双轮续接。完整 preflight 当时被未修改 dashboard 的类型错误阻断，不能报告全仓通过。
- 本次比较阶段只新增研究文档与临时探针，未进一步修改生产实现。前序补丁已在后续交接时独立提交；尚未部署。
- 没有进行覆盖所有客户端与模型的实测；尤其没有证据把原请求所有 260–270 秒等待都归结到某一条新发现。

## 源码索引

本地关键位置：

- [driver：消息分派、工具交接与 EOF 判定](../../packages/plugins/cursor/src/runtime/driver/driver.ts#L77)
- [参数 mapper：状态建立、快照缓存与完成](../../packages/plugins/cursor/src/runtime/stream/interaction/interaction.ts#L129)
- [root 历史构造](../../packages/plugins/cursor/src/runtime/history/history.ts#L51)
- [当前 McpArgs schema](../../packages/plugins/cursor/src/gen/agent_pb.ts#L8312)
- [模型入口：身份与 affinity](../../packages/plugins/cursor/src/runtime/cursor-model/cursor-model.ts#L108)
- [会话缓存：1 小时 TTL、2048 条、64 MiB](../../packages/plugins/cursor/src/store/session-store/session-store.ts#L5)
- [通用 300 秒空闲期限](../../packages/server/src/usage-capture/shared.ts#L8)

以下外部链接固定到调研提交，而非会变化的默认分支：

[opencodex]: https://github.com/lidge-jun/opencodex/tree/ec51e42d745d2645bcb22cb67855fa053ba1778e
[omp]: https://github.com/can1357/oh-my-pi/tree/3e181fe0cb73f8fbc8b5654335dee08177e2417b
[pi]: https://github.com/offbynan/pi-cursor-provider/tree/a89ac0ff34d1d6209f5a40a0b362cce0eea5915c
[omni]: https://github.com/diegosouzapw/OmniRoute/tree/aa912c42a7d50dd4c87c356f42218ccd2ff42c59
[bridge]: https://github.com/7iook/cursor-bridge/tree/03187f574e2fdf0b2d9f6854e02c88ad2846b0c6
[proto]: https://github.com/greenSheep999/cursor-proto/tree/193173315486ee98d382339d1d4a59ebc95574aa
[c2a]: https://github.com/NGLSG/Cursor2API/tree/d3adc7e59ce5b76f5630ab3df17841fe71ab8964
[ocx-mapper]: https://github.com/lidge-jun/opencodex/blob/ec51e42d745d2645bcb22cb67855fa053ba1778e/src/adapters/cursor/protobuf-events.ts#L1253-L1326
[ocx-finalize]: https://github.com/lidge-jun/opencodex/blob/ec51e42d745d2645bcb22cb67855fa053ba1778e/src/adapters/cursor/live-transport.ts#L968-L999
[ocx-query]: https://github.com/lidge-jun/opencodex/blob/ec51e42d745d2645bcb22cb67855fa053ba1778e/src/adapters/cursor/live-transport.ts#L1439-L1519
[ocx-end]: https://github.com/lidge-jun/opencodex/blob/ec51e42d745d2645bcb22cb67855fa053ba1778e/src/adapters/cursor/live-transport.ts#L1167-L1195
[ocx-health]: https://github.com/lidge-jun/opencodex/blob/ec51e42d745d2645bcb22cb67855fa053ba1778e/src/adapters/cursor/live-transport.ts#L794-L850
[omp-args]: https://github.com/can1357/oh-my-pi/blob/3e181fe0cb73f8fbc8b5654335dee08177e2417b/packages/ai/src/providers/cursor.ts#L4064-L4093
[omp-schema]: https://github.com/can1357/oh-my-pi/blob/3e181fe0cb73f8fbc8b5654335dee08177e2417b/packages/ai/src/providers/cursor/proto/agent.proto#L2113-L2122
[omp-approval]: https://github.com/can1357/oh-my-pi/blob/3e181fe0cb73f8fbc8b5654335dee08177e2417b/packages/ai/src/providers/cursor.ts#L1902-L1934
[omp-history]: https://github.com/can1357/oh-my-pi/blob/3e181fe0cb73f8fbc8b5654335dee08177e2417b/packages/ai/src/providers/cursor.ts#L4857-L4960
[omp-query]: https://github.com/can1357/oh-my-pi/blob/3e181fe0cb73f8fbc8b5654335dee08177e2417b/packages/ai/src/providers/cursor/interaction-query.ts
[pi-ping]: https://github.com/offbynan/pi-cursor-provider/blob/a89ac0ff34d1d6209f5a40a0b362cce0eea5915c/h2-bridge.mjs#L90-L128
[pi-resume]: https://github.com/offbynan/pi-cursor-provider/blob/a89ac0ff34d1d6209f5a40a0b362cce0eea5915c/proxy.ts#L1181-L1218
[omni-resume]: https://github.com/diegosouzapw/OmniRoute/blob/aa912c42a7d50dd4c87c356f42218ccd2ff42c59/open-sse/executors/cursor.ts#L1229-L1359
[bridge-session]: https://github.com/7iook/cursor-bridge/blob/03187f574e2fdf0b2d9f6854e02c88ad2846b0c6/bridge/src/sessions.mts#L135-L222
[bridge-replay]: https://github.com/7iook/cursor-bridge/blob/03187f574e2fdf0b2d9f6854e02c88ad2846b0c6/bridge/src/replay.mts#L1-L151
[c2a-queue]: https://github.com/NGLSG/Cursor2API/blob/d3adc7e59ce5b76f5630ab3df17841fe71ab8964/scripts/cursor-sdk-local-agent-bridge.mjs#L220-L377
[c2a-events]: https://github.com/NGLSG/Cursor2API/blob/d3adc7e59ce5b76f5630ab3df17841fe71ab8964/worker/openai.ts#L588-L652
