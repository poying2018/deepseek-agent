# DeepSeek Agent v1.3.9 发布说明 — 失控轮次自动止损（dsh-runaway-guard）

## 修的问题

Agent 自己转圈时停不下来。一次真实的失控轮：**57 步 / 93 个不同工具调用 / 11.2M token**，
界面上是一串「Go. OK. Writing. Let me output.」，最后只能用户手动点停止。

## 实测根因

内核**没有任何步数上限可配**：`dsh-agent-loop` 的配置项只有 `maxParallelToolCalls`
（单步内并行执行几个工具，默认 10），跟"这一轮该不该继续"无关。把 `@deepseek-ai/*` 全量搜过
`maxSteps` / `stepLimit` / `turnBudget` / `shouldContinue`，一个都没有。所以闸门只能自己加。

加的位置是内核已经开好的口子 `agent/pre-step`（waterfall）：

| 返回值 | 效果 |
| --- | --- |
| `next()` 的结果 | 照常进这一步 |
| `{ kind:'enter', messages:[…] }` | 替换/追加进入这一步的消息 |
| `{ kind:'reject' }` | 不再开新步，`turn/end` 的 reason 是 `blocked`（干净收尾，不是 error） |

`payload` 自带 `{agent, turn, step, signal, messages}`，`step` 从 1 开始、每轮归零。
走 `reject` 而不是 `agent.cancel({kind:'hook'})`：cancel 是掐断，会留下半截工具调用；
reject 是"这一步不开了"，日志边界干净且可归因。

## 修法

新增仓内零依赖插件 `builtin-plugins/dsh-runaway-guard`（不 import 任何 `@deepseek-ai/*`，
所以不占解析链接、也不会因为内核升轨而签名失配），两级反应，先劝后掐：

1. **软阈值**：单轮 ≥ 25 步，或**同一条工具调用**（名字 + 参数完全一样）连续 3 次 →
   往这一步追加一条 plugin 署名的 `instructions` 消息，要求模型立刻停止调用工具，
   并用一条消息交代：已得出的结论 / 已改动产出的文件 / 未完成部分与建议的下一步。
2. **硬阈值**：劝退后再放行 4 步仍不收，或同一调用重复到 5 次 → `reject` 关掉这一轮。

三条不插手的红线，专治误伤：

- 这一步领取到了**真人输入**（你在手动 steer / 排队消息）→ 完全放行，人在盯着就不算失控；
- 本轮最后一次模型输出**没有再点工具**（循环正要自然收口）→ 不动手，也不把 `completed` 改成 `blocked`；
- 看门狗自己抛异常 → 放行本步，只留一行日志，绝不连累对话。

阈值可在 `settings.yaml` 的 `dsh-runaway-guard` 段覆盖（模板里已带注释说明）；
`DSH_RUNAWAY_GUARD=0` 整体停用，`DSH_RUNAWAY_GUARD_MAX_STEPS` 等可临时调参。

## 验证

- **回归断言**：新增 `pnpm check:guard`，33 条断言覆盖逐级反应、原地打转、三条红线、
  配置夹取（坏值 / 越界 / `repeatHard < repeatLimit` 自动抬高）与异常兜底。
- **真实 dispatcher**：一次性探针用真 cordis `ctx.plugin` + `ctx.waterfall` 装载派发，
  确认监听器形状是 `(payload, next)`、三种返回值都被内核接受。
- **真机端到端**（把阈值压到 6 步跑真账号会话）：
  - 第一版只触发了关轮，**软阈值一次都没发** —— 因为拿 `pre-step` 的 `messages.length`
    当"循环还在转"的信号，而正常工具轮里那个数组本来就是空的（工具结果走 `tool/result`
    事件进历史，不再作为 `user/message` 领取）。假 ctx 的测试发现不了，只有真机能抓。
    改为判"本轮最后一次 `assistant/message` 里有没有 `tool-call` 块"。
  - 修好后的会话日志：第 6 步出现
    `user/message source={"kind":"plugin","plugin":"dsh-runaway-guard","form":"instructions"}`，
    模型随即输出「## 1) 目前已经得出的结论 …」并**以 `reason={"kind":"completed"}` 正常收尾**；
    修好前的另一轮则是 7 步后 `reason={"kind":"blocked"}`，124K tok 收住。
  - 这种注入在界面上渲染成「上下文注入 · dsh-runaway-guard」一行（与内核自己的
    system-prompt snapshot / skill-catalog 同族），不会伪装成用户说的话。
- 插件 peer 检查、目录选择器组合检查、启动判定检查三项门禁通过；
  `prepare-bundle` 已确认把 `dsh-runaway-guard (in-repo)` 打进暂存区。

> ℹ️ 装完建议完全退出再启动（本版改动在 app.asar 与插件目录里，不能热修）。
> 默认阈值 25/29 步是按"正常重任务很少过 20 步"取的，如果你的工作流确实需要更长的
> 单轮，把 `maxSteps` 调大即可，不必关掉整个看门狗。
