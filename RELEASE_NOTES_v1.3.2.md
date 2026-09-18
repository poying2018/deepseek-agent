# DeepSeek Agent v1.3.2 发布说明 — CPU 占用深度优化

> 在 v1.3.1（GPU 加速 + 防后台节流）基础上，本次聚焦**削减 Chromium 在后台/空闲时的 CPU 空转**，
> 这些开关不依赖内核改动，全部落在 Electron 外壳 `src/main/index.js` 的 `app.ready` 之前。

## 改动内容

新增 8 个 Chromium 命令行开关（均须在 `app.ready` 前设置）：

| 开关 | 作用 | 省 CPU 来源 |
|------|------|-------------|
| `disable-background-networking` | 停掉 Chromium 自有后台网络 | 组件更新/安全浏览/连通性探测等持续心跳 |
| `disable-component-update` | 禁止组件后台自更新轮询 | 更新检查定时器 |
| `disable-default-apps` | 不预拉取默认应用清单 | 启动期网络 + 解析 |
| `disable-extensions` | 关闭扩展子系统 | 扩展宿主常驻与扫描 |
| `disable-sync` | 关闭 Chrome 同步 | 无账号体系，纯省 CPU |
| `disable-translate` | 关闭内置翻译服务 | 翻译后端常驻 |
| `disable-metrics` | 关闭遥测录制与上报 | 遥测采样/上报线程 |
| `disable-features=...` | 关掉会偷吃 CPU 的特性 | 见下 |

`disable-features` 关闭的特性：
- `CalculateNativeWinOcclusion`：**Windows 原生窗口遮挡计算**，空闲时周期性触发重绘，是空闲 CPU 大户（AMD/N 卡尤甚）
- `Translate` / `BackForwardCache` / `MediaRouter` / `OptimizationHints` / `DocumentPictureInPicture`：翻译、BF 缓存、投屏(mDNS/SSDP)发现、优化提示、画中画

## 不影响的部分（明确边界）
- **不触碰内核**：`@deepseek-ai/dsh` 冷启动 30–40s 的 cordis 串行加载是内核固定成本，本发行版不改其源码。
- **不影响自身网络**：LLM/工具调用走 renderer/node 的 `fetch`，与 `disable-background-networking` 无关。
- **不改后台节流策略**：v1.3.1 的 `disable-background-timer-throttling` 等三条 anti-throttle 仍保留，
  Token 监控、插件轮询等本应用后台任务继续正常响应（只砍 Chromium 自己的闲时消耗）。

## 验证
- 仓库 `src/main/index.js` 与已安装版 `resources/app.asar` 均已植入上述开关并校验通过。
- 已安装版已热修重打包（备份：`resources/app.asar.bak.cpu`），**完全退出后重启即生效**。

## 配套说明
- 版本号：`package.json` 1.3.1 → 1.3.2。
- 如需正式发布安装包，跑 CI（双平台）构建并打 GitHub Release 即可；源码改动已就绪。
