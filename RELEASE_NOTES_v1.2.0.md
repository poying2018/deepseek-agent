# DeepSeek Agent v1.2.0

## 🏷️ 品牌内部标识统一：JackDSH / jackdsh → LJANX / ljanx

本版把项目里所有原作者的品牌字样（`JackDSH`、`jackdsh`、`JackAIStudio`、预设 id `jack`）统一为 **LJANX / ljanx**。对外品牌名仍是 **DeepSeek Agent**。

### 改名范围
| 项 | 旧值 | 新值 |
| :--- | :--- | :--- |
| Electron 应用名（决定数据目录） | `jackdsh` | `ljanx` |
| 安装标识 appId | `com.jackaistudio.jackdsh` | `com.ljanx.agent` |
| 作者元数据 | `JackAIStudio` | `LJANX` |
| 预加载桥 | `window.jackdshNative` | `window.ljanxNative` |
| IPC 通道前缀 | `jackdsh:*` | `ljanx:*` |
| 环境变量前缀 | `JACKDSH_*` | `LJANX_*` |
| 出厂 Agent 预设 | `jack`（Jack 模式） | `ljanx`（LJANX 模式） |
| 当日工作区根目录 | `~/Documents/JackDSH` | `~/Documents/LJANX` |
| 托管区标记 | `JackDSH 托管区` | `LJANX 托管区` |

### 老安装自动迁移（无需手工操作）
1. **数据目录**：首次启动自动 `%APPDATA%\jackdsh` → `%APPDATA%\ljanx`（同盘 rename，瞬时完成；工作区/会话/模型授权原样保留）。若旧版仍在运行导致目录被占用，会回退继续使用旧目录并在下次启动重试。
2. **Agent 预设**：`.agent-presets/jack` 的内容复制到 `.agent-presets/ljanx`，并把 `settings.yaml` 的 `agent-presets.default` 指向新 id。
3. **托管补丁区**：旧标记自动升级为新标记后整段重写，避免新旧托管区并存导致补丁 id 重复。
4. **当日工作区**：宿主与内置的 `dsh-today` 插件都改用 `~/Documents/LJANX`（插件侧由构建期品牌对齐补丁同步，并保留旧目录只读回退）。

### 兼容保留（有意不删）
- `window.jackdshNative` 桥别名：上游社区插件（`dsh-app-badge`、`dsh-mobile-plus`、`dsh-plugin-dashboard`）用它探测桌面端，保留同名桥以免功能退化。
- `dsh-today` 对 `~/Documents/JackDSH` 的只读回退：老用户的既有当日工作区仍可被找到。

### ⚠️ 升级步骤（appId 变更）
1. 关闭旧版应用；
2. 安装本版（会作为**独立应用**安装，不覆盖旧版）；
3. 打开确认工作区/会话/模型授权都在（数据自动迁移）；
4. 在「应用和功能」里卸载旧版条目（顺带清掉旧的 NSIS 注册表键）。

## 🚑 累计修复（自 v1.0.2 起全部保留）
1. 启动即崩：connection-inject-webServer 补丁恢复 `webServer` inject
2. 历史加载失败：会话迁移器统一豁免 `*Signature` 成员
3. 部分模型无法切换：pi-ai 适配器对未知上下文窗口的模型省略 context 字段
4. 执行命令弹出终端窗口（Windows）：4 处子进程创建补 `CREATE_NO_WINDOW` / `windowsHide`
5. `dsh-web`（ctx.web 搜索/抓取）能力行默认集成于托管区

## 说明
- 内核：`@deepseek-ai/dsh` 全锁步组 **0.1.5-rc.2**（230 包同版本）
- prepare-bundle 补丁：10 个内核/宿主补丁 + 1 个插件品牌对齐补丁
- 代码仓库与本地目录名（`JackDSH`）未随本版改动，需要时另行处理
