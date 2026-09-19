# DeepSeek Agent v1.3.7 发布说明 — CodeArts「benefit not found」的实测结论与自愈

本版只动一件事：用户在 CodeArts 上遇到的 `本轮运行失败 codearts: benefit not found`。
结论是**账号/后端侧的状态问题，不是配置写错**；代码侧只加了自愈与更清楚的报错。

## 先说结论（用真实请求验证过，不是推测）

`codearts: benefit not found` 这行字**不在插件代码里**，是 CodeArts 后端在 HTTP 200 的 SSE 流里
回的 `error_msg`，适配器原样抛出（`llm-adapter.js` 的 `consumeSse`）。

用插件自己的 `sign.js` + `dsh-llm` 的 `attributionHeaders()` 对同一个账号各发两次最小请求，
结果非常明确：

| 模型 | 不带 `maas_type: benefit` | 带 `maas_type: benefit` |
|------|--------------------------|------------------------|
| `deepseek-v4-flash` | ✅ HTTP 200 正常出流 | ❌ `benefit not found` |
| `glm-5.3-flash` | ❌ `InferHub.002002009.404 The model is not registered` | ✅ 被接受（当时撞到 `TM.00001041` 并发上限） |

也就是说**插件原本的 benefit 名单方向是对的**：`glm-5.3-flash` 是 benefit 模型、必须带这个头；
`deepseek-v4-flash` 不是，带上反而会被拒。

于是 `benefit not found` 的含义是：**那条失败请求用的是 benefit 类模型（如 `glm-5.3-flash`），
而后端此刻不认这份 benefit 权益**（额度已用尽 / 并发占满 / 活动状态变化）。
这属于账号侧状态，改代码改不动它。

> ⚠️ 排查过程中我曾一度以为「名单漏了 deepseek-v4-flash」并把它加了进去 —— **实测会把
> `deepseek-v4-flash` 直接打坏**，已回滚。这条弯路记在这里，免得以后再踩：**不要往
> `MAAS_TYPE_BENEFIT_MODELS` 里加 deepseek-v4-\*。**

## 代码侧做了什么

不动名单，只加一层**自愈**与**能行动的报错**（`plugin-compat.js` 的 codearts 条目，5 处编辑）：

1. 新增可重试错误 `SseBenefitRetryError`；
2. 外层重试循环前声明一个「benefit 头取反」标记；
3. 每次请求按「插件内置表 XOR 取反标记」决定带不带 `maas_type`；
4. SSE 内嵌错误里命中 benefit 语义时抛可重试信号（而不是直接终止本轮）；
5. 消费 SSE 的 catch 里处理切换重试。

行为边界：

- **名单正确时这条路径永不触发** ⇒ 正常请求零影响（不会多一次往返）；
- 后端将来真的把某个模型在 benefit / 非 benefit 之间挪动，它能自动适应；
- 切换后仍失败时，抛出的错误会**带上模型名与建议**，而不是光秃秃一行 `benefit not found`。

## 你现在可以怎么做

- **把模型切到 `deepseek-v4-flash`** —— 实测当前可用（本发行版的默认模型已经是它，
  但**已存在的会话会保留自己选过的模型**，需要在输入框的模型菜单里手动切一次）。
- 如果坚持用 `glm-5.3-flash`：先在 CodeArts 侧确认免费额度与并发（后端提示上限 3 个并发会话，
  关掉多余的 CodeArts 会话可能就能恢复）。
- 应用内「设置 → 模型」里的 `disabledModels` 也可以自己把 `glm-5.3-flash` 关掉，避免误选。

## 验证

- 5 处补丁在副本上试打 → `node --check` 通过 → 才落到实装；实装文件同样通过语法校验。
- 13 条兼容补丁对实装文件的只读锚点校验：全部「可命中 / 已应用」，0 条失配。
- 后端行为结论来自**真实请求**（两个模型 × 两种头，共 4 次），不是读代码推测。
