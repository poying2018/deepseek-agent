# 🐳 DeepSeek Agent

> **DeepSeek Harness 的桌面客户端发行版** —— 开箱即用，无需手动安装 Node.js、配置运行环境或敲命令行。
>
> 本发行版本质是一次**打包整合**：底层是 DeepSeek 官方的 DeepSeek Harness 内核，上层集成了 23 个插件（含多款自研）。所有依赖都已打进安装包，装完即可离线启动，首次运行时会自动完成配置。

**当前版本：`1.0.0`**

> ℹ️ 本发行版曾用名 **JackDSH**。改名只影响对外展示（窗口标题、安装包、快捷方式、「应用和功能」里的显示名），**不影响已有数据** —— 详见 [品牌名与内部标识](#-品牌名与内部标识)。

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
   运行时配置与数据存放在用户专属目录（`%APPDATA%\jackdsh\dsh-data`），不污染系统全局开发环境；卸载时默认保留。

---

## 🧩 内置插件矩阵（23 个，全部独立开源）

构建时按 [`plugins.manifest.yaml`](plugins.manifest.yaml) 从公开仓库拉取源码并打进安装包，「所见即所开源」。

| # | 插件 | 作用 | 来源 |
| -- | :--- | :--- | :--- |
| 1 | `dsh-mobile-plus` | 局域网手机遥控：文字与文件对话，带图标化会话入口 | [JackAIStudio](https://github.com/JackAIStudio/dsh-mobile-plus) |
| 2 | `dsh-grok-oauth` | 独立、本机持有的 Grok（xAI）provider | [JackAIStudio](https://github.com/JackAIStudio/dsh-grok-oauth) |
| 3 | `dsh-gemini-oauth` | 独立、本机持有的 Gemini provider（经 Antigravity / Cloud Code Assist） | [JackAIStudio](https://github.com/JackAIStudio/dsh-gemini-oauth) |
| 4 | `dsh-deepseek-balance` | 输入框下方静默显示 DeepSeek API 余额，并提供设置页 | [JackAIStudio](https://github.com/JackAIStudio/dsh-deepseek-balance) |
| 5 | `dsh-today` | 拦截默认新会话，直接打开「当日工作区」 | [JackAIStudio](https://github.com/JackAIStudio/dsh-today) |
| 6 | `dsh-web-restart` | 侧栏一键重启 dsh web 服务 | [JackAIStudio](https://github.com/JackAIStudio/dsh-web-restart) |
| 7 | `dsh-workspace-path` | 侧栏工作区中心，接管官方目录选择器 | [JackAIStudio](https://github.com/JackAIStudio/dsh-workspace-path) |
| 8 | `dsh-robust-search` | 稳健的全文会话检索，隔离损坏数据 | [JackAIStudio](https://github.com/JackAIStudio/dsh-robust-search) |
| 9 | `dsh-reminder` | 任务完成提示音（peon-ping 移植） | [JackAIStudio](https://github.com/JackAIStudio/dsh-reminder) |
| 10 | `dsh-app-badge` | 系统 Dock / 任务栏未读角标 | [JackAIStudio](https://github.com/JackAIStudio/dsh-app-badge) |
| 11 | `dsh-session-navigator` | 增强会话搜索与导航（会话 ID 命中、引用复制、置顶） | [JackAIStudio](https://github.com/JackAIStudio/dsh-session-navigator) |
| 12 | `dsh-plugin-dashboard` | 插件与版本大盘：版本矩阵、无感热开关、一键诊断复制 | [JackAIStudio](https://github.com/JackAIStudio/dsh-plugin-dashboard) |
| 13 | `dsh-web-search-follow` | 联网搜索后端跟随当前会话模型 | [JackAIStudio](https://github.com/JackAIStudio/dsh-web-search-follow) |
| 14 | `dsh-workbuddy-dual` | 同时接入 WorkBuddy 国内版与海外版模型，双轨并发 | [JackAIStudio](https://github.com/JackAIStudio/dsh-workbuddy-dual) |
| 15 | `dsh-better-sidebar` | VSCode 风格侧栏（资源管理器 / 编辑器 / 终端） | [JackAIStudio](https://github.com/JackAIStudio/DSH-better-sidebar) |
| 16 | `dsh-paste-path` | 任意文件/文件夹的智能拖拽与路径粘贴 | [JackAIStudio](https://github.com/JackAIStudio/dsh-paste-path) |
| 17 | `dsh-autostart` | 跨平台开机自启动开关 | [JackAIStudio](https://github.com/JackAIStudio/dsh-autostart) |
| 18 | `dsh-browser-attach` | 经 CDP 接管本机真实 Chrome（复用登录态） | [JackAIStudio](https://github.com/JackAIStudio/dsh-browser-attach) |
| 19 | `dsh-cmdj-toggle` | Cmd/Ctrl+J 聚焦热键，折叠/展开侧栏 | [JackAIStudio](https://github.com/JackAIStudio/dsh-cmdj-toggle) |
| 20 | `dsh-connect-workbuddy` | 零配置接入 WorkBuddy 桌面端已登录模型 | [dingminhua](https://github.com/dingminhua/dsh-connect-workbuddy) |
| 21 | `dsh-codex-timeline` | 官方会话的搜索、收藏、分支与个性化 | npm |
| 22 | `@mlgbnb/dsh-archive-manager` | 归档会话的预览、恢复与删除 | npm |
| 23 | `@wxg-prc-cpg/browser-skill-dsh-plugin` | 暴露 BrowserSkill 浏览器自动化能力 | npm |

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

对外品牌名是 **DeepSeek Agent**，但仓库里有一批 `JackDSH` / `jackdsh` 字样属于**内部契约，不能随改名一起换掉**。动它们会直接损坏老用户的数据或升级路径：

| 标识 | 位置 | 为什么必须保留 |
| :--- | :--- | :--- |
| `"name": "jackdsh"` | `package.json` | Electron 的 `userData` 路径由它派生（`%APPDATA%\jackdsh`）。改了它，`dsh-data` 里的工作区、会话、模型授权会全部「消失」。**也不要为此调 `app.setName()`**，效果等价。 |
| `# >>> JackDSH 托管区 …` / `# <<< JackDSH 托管区 <<<` | `server-manager.js` 写入 `cordis.patch.yml` | 重写托管补丁区时是**精确匹配**这两个标记。改了标记，老用户 profile 里的旧托管区摘不掉，新旧并存 → 补丁 id 重复。 |
| `~/Documents/JackDSH` | `server-manager.js` 当日工作区输出目录 | 插件 `dsh-today` 把该路径硬编码为「品牌标准根目录」，改名会导致两边解析不一致。 |
| `com.jackaistudio.jackdsh` | `electron-builder.yml` 的 `appId` | NSIS 卸载注册表键的 GUID 由 appId 派生。改了会生成新 GUID，老版本在「应用和功能」里的条目变成删不掉的孤儿。 |

**要改的只有对外展示名**，入口是这两个：

- `electron-builder.yml` → `productName`（安装包名、exe 名、快捷方式、「应用和功能」显示名）
- `src/main/index.js` → `APP_NAME` 常量（窗口标题、macOS 应用菜单、关于面板、弹窗标题）

> 窗口标题还有一处细节：网页底座自带 `<title>DeepSeek Harness</title>`，不拦会顶掉发行版名。
> `page-title-updated` 里做的是**定向改写**（把底座名换成品牌名）而非整串覆盖，
> 这样 `dsh-app-badge` 加在前面的未读计数前缀 `(3) …` 不会被丢掉。

---

## 📄 开源许可

本项目采用 [MIT 许可证](LICENSE) 开源。各引用插件及依赖库遵循其各自的开源许可协议。欢迎在 GitHub Issues 提交问题反馈与改进建议。

> 🐳 **关于图标**：应用图标使用 DeepSeek 官方鲸鱼 Logo（品牌色 `#4D6BFE`），矢量路径取自官方站点。
> **该 Logo 及其商标权利归 DeepSeek 所有**，本项目仅为「DeepSeek Harness 桌面客户端」的视觉标识沿用，
> 不代表与 DeepSeek 官方存在隶属或背书关系；如官方提出异议，会立即替换为自制图标。
