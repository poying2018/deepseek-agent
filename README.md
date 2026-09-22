# 🐳 DeepSeek Agent

> **DeepSeek Harness 的桌面客户端发行版** —— 开箱即用，无需手动安装 Node.js、配置运行环境或敲命令行。
>
> **这是 `vanilla` 分支：纯净版（官方裸底）**。只打包官方内核本体
> （`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`），**不装任何插件**，
> 也不启用任何为插件服务的注入层。保留的只有两类：三处内核包补丁（设置页侧栏滚动、
> 未鉴权模型隐藏、内核启动提速）与外壳侧的启动 / GPU 优化。
>
> 用途是回答一个问题：某个行为问题到底是插件叠出来的，还是上游内核本身就有。
> 带 28 个插件的完整发行版在 **`main` 分支**（`git show main:README.md`）。
>
> 另有两处与插件无关、但裸底也必须保留的外壳适配：目录选择器的 browse 两面
> （否则在 Electron-as-Node 宿主里选不了工作区）与关闭 client HMR（否则多标签会耗尽 SSE 连接）。

**当前版本：`1.4.3-vanilla.1`（内核 `0.1.5-rc.2` = 官方 latest）**

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
