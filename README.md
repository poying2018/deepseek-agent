# 🐳 DeepSeek Agent

> **DeepSeek Harness 的桌面客户端发行版** —— 开箱即用，无需手动安装 Node.js、配置运行环境或敲命令行。
>
> 本发行版本质是一次**打包整合**：底层是 DeepSeek 官方的 DeepSeek Harness 内核，上层集成了 29 个插件（含多款自研）。所有依赖都已打进安装包，装完即可离线启动，首次运行时会自动完成配置。

**当前版本：`1.3.3`**

> ℹ️ v1.2.0 起内部标识由 **JackDSH / jackdsh** 统一为 **LJANX / ljanx**（对外品牌名仍为 DeepSeek Agent）。旧安装的数据目录会在首次启动时**自动迁移**（`%APPDATA%\jackdsh` → `%APPDATA%\ljanx`），工作区/会话/模型授权不受影响 —— 详见 [品牌名与内部标识](#-品牌名与内部标识)。

---

## 📥 下载

前往 [Releases 页面](https://github.com/poying2018/deepseek-agent/releases) 下载对应平台的安装包：

| 平台 | 格式 | 说明 |
| :--- | :--- | :--- |
| 🪟 **Windows** | `.exe` 安装包 | 标准安装向导，**可自选安装目录**（建议装到非系统盘），免管理员权限，自动创建桌面与开始菜单快捷方式；数据在用户目录，卸载默认保留 |
| 🍏 **macOS** | `.dmg` 镜像 | 面向 Apple Silicon（M1/M2/M3/M4），双击拖拽安装 |

> 💡 **macOS 首次打开提示"无法验证开发者"**：本项目为个人独立开源构建，未购买商业开发者证书。
> 请在 **系统设置 → 隐私与安全性** 点击 **"仍要打开"** 即可正常使用。

---

## ✨ 核心特性

1. **开箱即用，免配环境**
   运行所需的 Node 依赖、插件、CLI 工具全部内置在安装包里。不需要自己装 Node.js，也不需要执行任何 `npm`/`pnpm` 命令，双击即用。

2. **首次启动自动配置**
   启动时会自动生成隔离 profile：写入插件 bundles 清单、`cordis.patch.yml`、工作区配置，并把内置插件链接进 profile。全过程离线完成。

3. **局域网手机扫码控制**（自研 `dsh-mobile-plus`）
   电脑端提供配对二维码，同一 Wi-Fi 下手机扫码即可连接，在移动端查看任务进度、发送消息。
   *注：若路由器开启了 AP 隔离，局域网连接可能受阻。*

4. **多模型便捷接入**
   内置 Gemini / Grok 授权登录插件，以及 WorkBuddy 双轨并发直连，减少初期的折腾成本。

5. **数据本地隔离**
   运行时配置与数据存放在用户专属目录（`%APPDATA%\ljanx\dsh-data`），不污染系统全局开发环境；卸载时默认保留。

---

## 🧩 内置插件矩阵（23 个，全部独立开源）

构建时按 [`plugins.manifest.yaml`](plugins.manifest.yaml) 从公开仓库拉取源码并打进安装包，「所见即所开源」。

| # | 插件 | 作用 | 来源 |
| -- | :--- | :--- | :--- |
| 1 | `dsh-mobile-plus` | 局域网手机遥控：文字与文件对话，带图标化会话入口 | [LJANX](https://github.com/LJANX/dsh-mobile-plus) |
| 2 | `dsh-grok-oauth` | 独立、本机持有的 Grok（xAI）provider | [LJANX](https://github.com/LJANX/dsh-grok-oauth) |
| 3 | `dsh-gemini-oauth` | 独立、本机持有的 Gemini provider（经 Antigravity / Cloud Code Assist） | [LJANX](https://github.com/LJANX/dsh-gemini-oauth) |
| 4 | `dsh-deepseek-balance` | 输入框下方静默显示 DeepSeek API 余额，并提供设置页 | [LJANX](https://github.com/LJANX/dsh-deepseek-balance) |
| 5 | `dsh-today` | 拦截默认新会话，直接打开「当日工作区」 | [LJANX](https://github.com/LJANX/dsh-today) |
| 6 | `dsh-web-restart` | 侧栏一键重启 dsh web 服务 | [LJANX](https://github.com/LJANX/dsh-web-restart) |
| 7 | `dsh-workspace-path` | 侧栏工作区中心，接管官方目录选择器 | [LJANX](https://github.com/LJANX/dsh-workspace-path) |
| 8 | `dsh-robust-search` | 稳健的全文会话检索，隔离损坏数据 | [LJANX](https://github.com/LJANX/dsh-robust-search) |
| 9 | `dsh-reminder` | 任务完成提示音（peon-ping 移植） | [LJANX](https://github.com/LJANX/dsh-reminder) |
| 10 | `dsh-app-badge` | 系统 Dock / 任务栏未读角标 | [LJANX](https://github.com/LJANX/dsh-app-badge) |
| 11 | `dsh-session-navigator` | 增强会话搜索与导航（会话 ID 命中、引用复制、置顶） | [LJANX](https://github.com/LJANX/dsh-session-navigator) |
| 12 | `dsh-plugin-dashboard` | 插件与版本大盘：版本矩阵、无感热开关、一键诊断复制 | [LJANX](https://github.com/LJANX/dsh-plugin-dashboard) |
| 13 | `dsh-web-search-follow` | 联网搜索后端跟随当前会话模型 | [LJANX](https://github.com/LJANX/dsh-web-search-follow) |
| 14 | `dsh-better-sidebar` | VSCode 风格侧栏（资源管理器 / 编辑器 / 终端） | [LJANX](https://github.com/LJANX/DSH-better-sidebar) |
| 15 | `dsh-paste-path` | 任意文件/文件夹的智能拖拽与路径粘贴 | [LJANX](https://github.com/LJANX/dsh-paste-path) |
| 16 | `dsh-autostart` | 跨平台开机自启动开关 | [LJANX](https://github.com/LJANX/dsh-autostart) |
| 17 | `dsh-browser-attach` | 经 CDP 接管本机真实 Chrome（复用登录态） | [LJANX](https://github.com/LJANX/dsh-browser-attach) |
| 18 | `dsh-cmdj-toggle` | Cmd/Ctrl+J 聚焦热键，折叠/展开侧栏 | [LJANX](https://github.com/LJANX/dsh-cmdj-toggle) |
| 19 | `@mlgbnb/dsh-archive-manager` | 归档会话的预览、恢复与删除 | npm |
| 20 | `@wxg-prc-cpg/browser-skill-dsh-plugin` | 暴露 BrowserSkill 浏览器自动化能力 | npm |
| 21 | `dsh-codearts-auth` | 华为云 CodeArts / CodeBuddy / WorkBuddy 一顶三的账号接入：浏览器登录、静默续期、积分与模型开关 | [iJetLi](https://gitee.com/iJetLi/deepseek-harness-codearts) |
| 22 | `dsh-connect-trae` | 把本机已登录的 Trae 账号接成 provider，附只读用量卡片 | npm |
| 23 | `dsh-damage-pulse` | Token 余额监控：鲸鱼娘待机/扣费动画、峰谷计费、会话费用统计 | [wssfk12138](https://github.com/wssfk12138/dsh-damage-pulse) |
| 24 | `dsh-undo-savepoint` | 配置与插件代码变更的可回滚快照、一键 SAFE MODE、离线救援 CLI | [lire1131](https://github.com/lire1131/dsh-undo-savepoint) |
| 25 | `dsh-provider-qoder` | 把 Qoder 订阅账号接成 provider：COSY 签名流式、PAT 安全存储、实时模型目录、企业 VPC | [mo-n](https://github.com/mo-n/dsh-provider-qoder) |
| 26 | `dsh-dream-skin` | 换肤：8 套 iOS / Linear 式冷调主题 + 弥散光壁纸 + 强调色 + 主题包分享（**默认不启用**） | [RevolutionLA](https://github.com/RevolutionLA/dsh-dream-skin) |
| 27 | `dsh-client-ui-seaglass` | 玻璃拟态主题：模糊、霜化、圆角、动效均可调（**默认不启用**） | [xiyunyunyun](https://github.com/xiyunyunyun/dsh-client-ui-seaglass) |
| 28 | `dsh-skin-manager` | 皮肤发现与互斥切换的独立设置页，含「恢复官方外观」（**默认不启用**） | npm |
| 29 | `dsh-update-check` | 侧栏「检查更新」：查 GitHub Release、展示变更说明、就地下载 | 仓内自带 |

> **另有两条说明**：
> · `dsh-codex-timeline` 随包分发，但它显式声明「仅验证到内核 0.1.2-alpha.3」，
>   而本版内核是 0.1.5-rc.2，打包时的内核兼容性门禁会把它置为停用，所以在插件列表里看不到它。
> · 换肤三件套（`dsh-dream-skin` / `dsh-client-ui-seaglass` / `dsh-skin-manager`）随包但**默认不启用**，
>   在插件面板里打开即可，全程离线。
>
> 另外还内置了 BrowserSkill 的 `bsk` CLI（`bundle-runtime/bin/`），供浏览器自动化插件调用。

---

## 🏗️ 构建

```bash
pnpm install                    # 安装依赖（必须是 hoisted 扁平布局，见下）
node scripts/prepare-bundle.js  # 按清单拉取插件 → bundle-runtime/
pnpm build:win                  # Windows 安装包
pnpm build:mac                  # macOS 镜像
```

产物默认输出到 `~/.jds-build-out/`（`build.js` 会覆盖 `electron-builder.yml` 里仓库内的 `release/`）。

构建源完全透明：GitHub Actions（[`.github/workflows/release.yml`](.github/workflows/release.yml)）同样按 `plugins.manifest.yaml` 的公开清单拉取插件后打包。本地开发时若 `../plugins/<name>` 存在，`prepare-bundle.js` 会优先复用本地源码。

> ⚠️ **依赖布局陷阱**：`electron-builder` 的 `extraResources` 排除了 `.pnpm/**`，
> 所以根 `node_modules` **必须**是 hoisted 扁平布局。若落成 pnpm 默认的 isolated（软链进 `.pnpm`），
> 打进包的就是一堆死链，而构建过程**不会报错**。`pnpm-workspace.yaml` 里已显式声明 `nodeLinker: hoisted`。

---

## 🏷️ 品牌名与内部标识

对外品牌名是 **DeepSeek Agent**；内部标识自 **v1.2.0** 起统一为 **LJANX / ljanx**（此前为 JackDSH / jackdsh）。

### 改名时的自动迁移（老安装无需手工操作）

| 迁移项 | 旧值 → 新值 | 实现位置 |
| :--- | :--- | :--- |
| Electron 数据目录 | `%APPDATA%\jackdsh` → `%APPDATA%\ljanx` | `src/main/index.js` → `migrateLegacyUserData()`（同盘 rename；若旧版仍在运行导致占用，则回退继续用旧目录，下次启动再试） |
| Agent 预设 id | `jack` → `ljanx`（含 `.agent-presets/` 目录内容） | `src/main/server-manager.js`（拷贝旧预设内容 + 改 `settings.yaml` 的 `agent-presets.default`） |
| `cordis.patch.yml` 托管区标记 | `JackDSH 托管区` → `LJANX 托管区` | `src/main/server-manager.js`（先把旧标记升级为新标记，再整段重写，避免新旧托管区并存导致补丁 id 重复） |
| 当日工作区根目录 | `~/Documents/JackDSH` → `~/Documents/LJANX` | 宿主 `resolveInitialWorkspace()`；上游插件 `dsh-today` 由 `scripts/prepare-bundle.js` 的**品牌对齐补丁**同步改写（保留旧目录只读回退） |

### 有意保留的旧名（兼容，勿删）

| 标识 | 位置 | 为什么保留 |
| :--- | :--- | :--- |
| `window.jackdshNative` | `src/preload/preload.cjs` | 上游社区插件（`dsh-app-badge`、`dsh-mobile-plus`、`dsh-plugin-dashboard` 等）用它探测「是否在桌面客户端里」。改名后仍以同名桥暴露同一对象，避免这些插件退化。待上游改用 `window.ljanxNative` 后可移除。 |
| `JackDSH`（只读回退） | `dsh-today` 的 `resolve.js` | 老用户的当日工作区在旧目录里；补丁让插件 LJANX 优先、旧目录兜底，数据不「消失」。 |
| `com.jackaistudio.jackdsh`（历史 appId） | 系统卸载注册表 | v1.2.0 起 appId 改为 `com.ljanx.agent`：新安装包会作为**独立应用**安装，旧版本的卸载条目需要手动清理一次。 |

### 对外展示名的入口

- `electron-builder.yml` → `productName`（安装包名、exe 名、快捷方式、「应用和功能」显示名）
- `src/main/index.js` → `APP_NAME` 常量（窗口标题、macOS 应用菜单、关于面板、弹窗标题）

> ⚠️ 升级步骤：关闭旧版 → 安装新版（数据自动迁移）→ 打开确认工作区/会话正常 → 在「应用和功能」里卸载旧版条目。

> 窗口标题还有一处细节：网页底座自带 `<title>DeepSeek Harness</title>`，不拦会顶掉发行版名。
> `page-title-updated` 里做的是**定向改写**（把底座名换成品牌名）而非整串覆盖，
> 这样 `dsh-app-badge` 加在前面的未读计数前缀 `(3) …` 不会被丢掉。

---

## 📄 开源许可

本项目采用 [MIT 许可证](LICENSE) 开源。各引用插件及依赖库遵循其各自的开源许可协议。欢迎在 GitHub Issues 提交问题反馈与改进建议。

> 🐳 **关于图标**：应用图标使用 DeepSeek 官方鲸鱼 Logo（品牌色 `#4D6BFE`），矢量路径取自官方站点。
> **该 Logo 及其商标权利归 DeepSeek 所有**，本项目仅为「DeepSeek Harness 桌面客户端」的视觉标识沿用，
> 不代表与 DeepSeek 官方存在隶属或背书关系；如官方提出异议，会立即替换为自制图标。
