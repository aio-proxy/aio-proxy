---
description: Token 消耗统计、模型定价核算、活动热力图与 OAuth 订阅账号的 API 等效价值换算。
---

# 用量与计费统计

AIO Proxy 会精确计量每一个通过代理完成的请求 Token 数量，并依据配置的模型价格实时计算出折算费用。

## 核心度量指标

- **输入 Token (Input Tokens)**：客户端发送的提示词所消耗的 Token 数。
- **输出 Token (Output Tokens)**：大模型生成回复所消耗的 Token 数。
- **缓存读取 (Cache Read Tokens)**：命中 Prompt Cache 的 Token 数（在 Anthropic 或 OpenAI 支持缓存的模型上，该部分通常享受极大的费率折扣）。
- **思考推理 Token (Reasoning Tokens)**：由 DeepSeek-R1、o1、o3 等思考型模型在隐式思考阶段消耗的 Token 数。

## 多维度可视化报表

1. **日消耗趋势图**：直观展示过去 7 天或 30 天的每日调用量与费用走势。
2. **Token 活动热力图 (Activity Heatmap)**：类似 GitHub Commit 图谱的 24 小时/星期热力图，快速定位高频调用高峰时段。
3. **模型分布环形图**：清晰分析团队或应用对各主流模型（如 GPT-5、Claude 3.5、DeepSeek 等）的消耗占比。

## OAuth 订阅的“API 等效价值”换算

许多用户接入了个人或团队的 ChatGPT Plus/Pro、Claude Pro 或 GitHub Copilot 账号。这些账号通常采用包月固定订阅费：

- AIO Proxy 会根据官方公开的商业 API 定价矩阵，自动换算你通过这些订阅账号所消耗的 Token 相当于多少官方 API 费用。
- 帮助你量化订阅价值，评估额度使用收益。
