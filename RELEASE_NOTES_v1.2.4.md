# DeepSeek Agent v1.2.4

## 🐛 修复：已归档的会话无法正常显示

### 根因（归档插件与本发行版的隔离环境不匹配）
`@mlgbnb/dsh-archive-manager` 有两处硬编码假设，与本发行版运行内核的方式冲突：

| # | 插件的行为 | 实际情况 | 后果 |
|---|---|---|---|
| 1 | `dshHome()` 硬编码为 `~/.dsh` | 本发行版给内核设置了**隔离数据目录** `%APPDATA%\ljanx\dsh-data`（环境变量 `DSH_HOME`） | 插件去读遗留的 `~/.dsh`（旧数据/空），归档列表读不到 |
| 2 | 只认旧的**单文件**投影缓存 `storages/session_projcache.json` | 内核 0.1.5 起投影缓存改为**分目录**存储 `storages/session_projcache/sessions/<id>.json`（记录结构一致） | 会话标题/轮次/用量等元数据全部取不到 |

### 修复（构建期插件补丁，表驱动幂等）
1. `dshHome()` 优先读 `DSH_HOME`（`JACKDSH_HOME` 兼容），找不到才退回 `~/.dsh`；
2. 新增 `readProjcacheCompat()`：单文件与分目录两种布局都认，统一成插件原本期望的
   `{ tables: { sessions } }` 形态；两处调用点（列表 / 删除）一并改用它。

### 验证
- 用补丁后的插件在隔离 `DSH_HOME` 下**实测**：读到 6 个归档 id、7 条投影缓存记录，
  `listArchives()` 正常返回 6 条归档（含标题「问候与交流」「Install dsh market plugin…」
  「用户向编程助手说你好」等）与数据体积。

## 说明
- 另：`dsh plugin --profile web add dsh-web` 不会生效，因为 **npm 上不存在名为 `dsh-web` 的包**
  （`@deepseek-ai/dsh-web` 是内核的 `ctx.web` 服务行，不通过 pnpm 安装）。本发行版已在托管区
  显式启用 `web` / `web-fetch-http`，工具层由 Agent 预设（`ljanx` 预设含 `tool-web`）挂载。
- 其余修复保持不变：Jet Hub 登录只开一个系统浏览器（v1.2.2）、面板版本号显示（v1.2.3）、
  安装器智能识别已有安装目录（v1.2.1）、品牌改名与自动迁移（v1.2.0）。
