# DeepSeek Agent v1.3.1 发布说明

## 🚀 性能优化（Electron 外壳层）

本版针对 UI 流畅度与后台响应做了一组 Electron 启动期优化，全部在 `src/main/index.js` 的 `app.ready` 之前设置：

### 1. GPU 用得更满（渲染更顺）
- `ignore-gpu-blocklist`：解除对核显（本机 AMD 780M）的 GPU blocklist，强制走硬件渲染而非 SwiftShader 软件渲染。
- `enable-gpu-rasterization`：把图层光栅化也放到 GPU，降低 CPU 占用——鲸鱼娘待机/扣费/复苏动画、长列表滚动、Markdown 渲染明显更顺。

> 调试日志已确认 Chromium 此前走的是 ANGLE/D3D11 硬件路径，本次是在此基础上进一步「用满」，不会引入软件渲染回退风险。

### 2. 防止后台节流（后台任务不卡顿）
- `disable-background-timer-throttling` / `disable-backgrounding-occluded-windows` / `disable-renderer-backgrounding`：
  应用失焦、最小化、被其它窗口遮挡时，渲染进程与后台定时器不再被降频，保证 **Token 余额监控、插件轮询、会话计费统计** 等后台任务持续响应。

### 3. 减少启动期日志 I/O
- 渲染进程 → 主进程的 `console-message` 镜像从「全量转发」改为「只转 warning/error」：
  过滤 28 个插件启动期的 info 级刷屏，降低主进程 I/O 与启动期卡顿；info 级内容仍可在渲染进程内 DevTools 看到。

## ℹ️ 说明
- 内核（@deepseek-ai/dsh）的冷启动（约 30–40s，cordis 串行加载 28 个插件）属于 dsh 包内部行为，本发行版不改动其源码；本次优化集中在我们能控制的 Electron 外壳层。
- 已在本机安装版（v1.3.0）直接打补丁验证：重启后进程正常拉起、内核日志零错误，GPU 开关均已写入。

## 📦 安装包下载

> 平台附件上限 100MB，安装包请从 GitHub Release 下载（链接直达文件）：

- **Windows 安装包**：https://github.com/poying2018/deepseek-agent/releases/download/v1.3.1/DeepSeek-Agent-1.3.1-Windows-Setup.exe
- **macOS arm64 dmg**：https://github.com/poying2018/deepseek-agent/releases/download/v1.3.1/DeepSeek-Agent-1.3.1-Mac-arm64.dmg

---

## 完整变更
- `src/main/index.js`：新增 GPU + 防后台节流开关；`console-message` 改为只转 warning/error。
