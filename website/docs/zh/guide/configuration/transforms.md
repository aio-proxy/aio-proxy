---
description: AIO Proxy 声明式请求转换规则引擎：基于 MongoDB 语法的请求报文与请求头条件重写。
---

# 请求转换规则

有时某些上游 API 需要微调请求体（例如剔除不支持的实验性参数、重命名特定字段、注入特定的系统请求头）。AIO Proxy 内置了强大的声明式请求转换引擎，允许直接在配置中对出站报文进行精细修改。

转换管道配置在每个 Provider 的 `transforms.request` 中：

```jsonc title="config.jsonc"
{
  "providers": {
    "custom-upstream": {
      "kind": "api",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "{{env.UPSTREAM_KEY}}",
      "models": ["custom-model"],
      "transforms": {
        "request": [
          {
            "name": "移除不支持的 temperature 参数",
            "when": {
              "request.body.temperature": { "$exists": true },
            },
            "update": [{ "$unset": "request.body.temperature" }],
          },
          {
            "name": "修改特定请求头",
            "update": [
              {
                "$set": {
                  "request.headers": {
                    "$setField": {
                      "field": "x-custom-tenant-id",
                      "input": "$request.headers",
                      "value": "tenant-001",
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
}
```

## 规则结构

每条规则包含三个部分：

- **`name`**（可选）：人类可读的规则描述，会在链路日志中高亮显示。
- **`when`**（可选）：触发条件，满足条件时才会执行转换。省略时对所有出站请求生效。
- **`update`**（必填）：有序的更新阶段列表，按顺序对请求对象进行修改。

## 条件表达式 (`when`)

条件语法兼容 MongoDB Query 规范，支持：

- **比较操作符**：`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`
- **逻辑组合**：`$and`, `$or`, `$nor`, `$not`
- **存在性校验**：`$exists: true | false`
- **正则匹配**：`$regex` 与 `$options`
- **字段计算**：`$expr` 复杂条件（例如比较两个字段的计算结果）

## 更新阶段 (`update`)

每个阶段执行一个原子的写入或删除操作：

### 1. 删除字段 (`$unset`)

```jsonc
{ "$unset": "request.body.stream_options" }
```

### 2. 写入或替换字段 (`$set`)

支持字面量赋值或使用表达式引用现有请求属性：

```jsonc
{
  "$set": {
    "request.body.max_tokens": 4096,
  },
}
```

可用的内置根路径包括：

- `request.body.*`：出站请求体。
- `request.headers`：出站请求头字典。
- `original.headers.*`：客户端最初发送的原始请求头。
- `provider.*`：当前被调度提供商的基础元数据。

## 安全与防护约束

为杜绝原型链污染与不可预知的内存泄露，AIO Proxy 在规则解析阶段便强制执行安全白名单：

1. **原型注入阻断**：所有访问路径中严禁包含 `__proto__`、`constructor` 或 `prototype` 等危险属性。
2. **Header 规范化**：修改 Header 必须使用小写键名，符合标准 HTTP Token 字符集规范。
