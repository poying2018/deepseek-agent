# DeepSeek Agent v1.1.0

## 🆕 新增：dsh-web（ctx.web 搜索/抓取能力）默认集成

本发行版是**原生 Electron 应用**，不依赖上游 web 前端的组装方式。本版把 `dsh-web` 能力行显式纳入 JackDSH 托管区，保证其常驻启用：

| 行 | 包 | 作用 |
|---|---|---|
| `web` | `@deepseek-ai/dsh-web` | `ctx.web` 能力 seam：搜索 + 抓取统一入口、provider 选择、错误分类 |
| `web-fetch-http` | `@deepseek-ai/dsh-web-fetch-http` | 匿名公共 HTTP(S) 抓取 provider（DNS 校验 + 公网 IP 固定） |

搜索 provider 由本发行版内置插件 `dsh-web-search-follow` 提供的 `follow-search` 接管（`config.searchProvider` 由该插件合成）。

### ⚠️ 集成方式的注意事项（重要）
`@deepseek-ai/dsh-web` **不是插件包**，而是 `ctx.web` 的 Service 基类（`WebRuntime extends Service`），其 package.json 没有 `dsh.bundle` 字段。因此：

- **不能**把它加进 `dsh.profile.bundles` —— DSH 的 profile 组装器对 bundles 每一项都强制要求 `dsh.bundle`，缺失会直接让内核启动失败：
  `Error: profile bundle "@deepseek-ai/dsh-web" declares no dsh.bundle in its package.json`
- 正确做法是作为 **cordis 能力行**（host 侧）由 `dsh-base` 提供、并在托管区显式声明启用状态（本版实现）。

## 🚑 累计修复（自 v1.0.2 起全部保留）
1. **启动即崩**：connection-inject-webServer 补丁恢复 `webServer` inject
2. **历史加载失败**：会话迁移器统一豁免 `*Signature` 成员
3. **部分模型无法切换**：pi-ai 适配器对未知上下文窗口的模型省略 context 字段
4. **执行命令弹出终端窗口**（Windows）：4 处子进程创建补 `CREATE_NO_WINDOW` / `windowsHide`

## 说明
- 内核：`@deepseek-ai/dsh` 全锁步组 **0.1.5-rc.2**（230 包同版本）
- prepare-bundle 补丁总数：10（6 个 0.1.5 兼容 + 4 个终端弹窗）
- 用户个人 Agent 预设如为 0.1.2 旧格式（persona 用 `text`），需改为 `prefix`/`suffix`
