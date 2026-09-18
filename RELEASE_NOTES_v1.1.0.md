# DeepSeek Agent v1.1.0

## 🆕 新增：dsh-web 内核包默认集成

将 `@deepseek-ai/dsh-web`（ctx.web Service 基类）、`@deepseek-ai/dsh-web-fetch-http`（HTTP 抓取 provider）和 `@deepseek-ai/dsh-web-search-deepseek`（DeepSeek 搜索 provider）作为核心 bundle 默认注册进隔离 profile，与 `dsh-base`/`dsh-web-app` 同级。

三者均为 `@deepseek-ai/` 内核包（**非浏览器前端插件**），提供 `ctx.web` 的搜索/抓取能力——之前未注册会导致工具（如 `dsh-tool-web`）调用搜索或网页抓取时报 "no provider" 错误。

## 🚑 累计修复（自 v1.0.2 起全部保留）

1. **启动即崩**：connection-inject-webServer 补丁恢复 `webServer` inject
2. **历史加载失败**：会话迁移器统一豁免 `*Signature` 成员（textSignature/thinkingSignature/thoughtSignature）
3. **部分模型无法切换**：pi-ai 适配器对未知上下文窗口的模型省略 context 字段
4. **执行命令弹出终端窗口**（Windows）：4 处子进程创建补 `CREATE_NO_WINDOW` / `windowsHide`

## 说明
- 内核：`@deepseek-ai/dsh` 全锁步组 **0.1.5-rc.2**（230 包同版本）
- prepare-bundle 补丁总数：10（6 个 0.1.5 兼容 + 4 个终端弹窗）
- 用户个人 Agent 预设如为 0.1.2 旧格式（persona 用 `text`），需改为 `prefix`/`suffix`
