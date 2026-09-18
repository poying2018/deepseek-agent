# DeepSeek Agent v1.2.3

## 🐛 修复：插件面板显示的版本号「变回了旧值」

### 现象
应用是 1.2.2，但插件面板（`dsh-plugin-dashboard`）显示的发行版版本号却是旧值 **`0.1.2-rc.1`**。

### 根因（v1.2.0 品牌改名的遗留）
该插件的版本读取链有三层，改名后**三层全部落空**，于是走了硬编码兜底：

| 层 | 插件读的东西 | 改名后的实际情况 |
|---|---|---|
| 1 | 环境变量 `JACKDSH_VERSION` | 宿主已改为 `LJANX_VERSION` → 读不到 |
| 2 | 相邻 `JackDSH/package.json` 且 `name === 'jackdsh'` | 发行版包的 `name` 已改为 `ljanx` → 认不出 |
| 3 | 硬编码兜底 | 返回 `'0.1.2-rc.1'`（"官方安全回退默认值"） |

### 修复（三层都补上）
1. **宿主保留旧环境变量别名**（`src/main/server-manager.js`）：除 `LJANX_VERSION` 外同时设置
   `JACKDSH_VERSION`，便携/工作区根同理补 `JACKDSH_PORTABLE_ROOT` / `JACKDSH_WORKSPACE_ROOT`。
   —— 这样所有还在读旧名的上游插件（另如 `dsh-today`）都不会再静默回退到错误默认值。
2. **构建期插件补丁**（`prepare-bundle` 的 `PLUGIN_RUNTIME_PATCHES` 新增 `dsh-plugin-dashboard` 条目）：
   让插件同时认新旧环境变量名与新旧包名（`ljanx` / `jackdsh`）。
3. 面板显示的版本号恢复为真实发行版号（本版即 `1.2.3`）。

## 说明
- 品牌标识统一 LJANX / ljanx（v1.2.0 起）；上述「旧名别名」属**兼容保留**，待上游插件跟进改名后可移除。
- 其余修复保持不变：Jet Hub 登录只开一个系统浏览器（v1.2.2）、安装器智能识别已有安装目录（v1.2.1）、
  品牌改名自动迁移（v1.2.0）等。
