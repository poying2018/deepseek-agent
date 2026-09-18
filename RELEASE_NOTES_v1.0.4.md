# DeepSeek Agent v1.0.4

## 🚑 0.1.5 内核兼容性热修 + 终端弹窗修复（本版核心）
针对内核升级到 0.1.5 线后暴露的四个上游回归/兼容问题，全部以内核补丁方式在构建期修复（`prepare-bundle` 共 6 个补丁，幂等可重复执行）：

1. **启动即崩**：0.1.5 起 `dsh-client-connection` 删除 `webServer` inject 却仍在使用 → 任何调用 `ctx.connection.rpc.handle()` 的插件导致内核加载 profile 时崩溃。补丁恢复 inject。（connection-inject-webServer）
2. **历史加载失败**：会话迁移器（v0→v1）白名单未收录 LLM 提供方写入的签名成员（textSignature/thinkingSignature/thoughtSignature，出现在 text/reasoning/tool-call 各类内容块）→ 迁移拒绝。补丁统一豁免 `*Signature` 成员。（session-migrator-llm-signatures / session-migrator-signature-members）
3. **Jet Hub / Trae 插件 UI 永不出现**：rc.2 客户端模块图要求 `dsh.client.platform` 声明，老结构插件缺失 → 客户端被跳过。当插件有 `exports["./client"]` 但缺声明时按 web 平台自动合成。（client-modules-legacy-dsh-client）
4. **部分模型无法切换**（如 Trae 的 gemini-3.1-pro）：pi-ai 适配器对未知上下文窗口的模型无条件返回 `context:{contextWindow:undefined}` 被校验拒绝。修正为省略该字段。（pi-ai-model-context-undefined）
5. **执行命令弹出终端窗口**（Windows）：Electron 主进程无控制台，4 处子进程创建调用缺 `CREATE_NO_WINDOW` / `windowsHide` → 系统为每个子进程分配控制台，默认终端（Windows Terminal）弹出可见窗口。已为全部 4 处补充该标志。（win32-process-create-no-window / win32-process-job-suspended-no-window / win32-process-createw-no-window / subprocess-local-windows-hide）

## 其他
- `pnpm update-core` 升级内核时自动同步 overrides 锁步钉子，杜绝再次混版。
- 检查更新面板新增「当前应用」详情区；修复 API 限流时误报「未填写更新说明」。

## 说明
- 内核：`@deepseek-ai/dsh` 全锁步组 **0.1.5-rc.2**（230 包同版本，一致性已验证）。
- `dsh-codex-timeline` 维持停用（作者仅声明支持 0.1.2-alpha.3），适配后自动恢复。
- 用户个人 Agent 预设（如 jack）如为 0.1.2 旧格式（persona 用 `text`），请参照 standard 预设改为 `prefix`/`suffix`。
