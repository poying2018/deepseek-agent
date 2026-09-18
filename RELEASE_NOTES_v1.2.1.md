# DeepSeek Agent v1.2.1

## 🆕 安装器：智能识别已有安装位置（默认覆盖安装）

安装向导的默认安装目录现在会**自动指向机器上已有的安装目录**，直接覆盖升级，不再默认装到 `%LOCALAPPDATA%\Programs\DeepSeek Agent` 留下第二份。

### 为什么需要它
v1.2.0 换了 appId（`com.jackaistudio.jackdsh` → `com.ljanx.agent`）。NSIS 的卸载注册表键 GUID 由 appId 派生，所以 electron-builder 自带的「读同一 appId 的 `InstallLocation` 定位旧版本」在跨 appId 升级时必然失效 —— 本版补上跨品牌兜底。

### 检测顺序（`build/installer.nsh` → `customInit`）
1. 命令行给了 `/D=<目录>` → 完全尊重用户，不介入；
2. 扫卸载表（HKCU + HKLM 64/32 位视图），`DisplayName` 命中本发行版品牌（`DeepSeek Agent` / `LJANX` / `JackDSH`）→ 取 `InstallLocation`；该值缺失时（实测 1.0.4 的键里就没有）退回 `DisplayIcon`（electron-builder 写的是 `<安装目录>\<主程序>.exe,0`，去尾部 `,0` 再取父目录）；
3. 注册表一无所获时，探常见目录（用户级 `Programs`、`Program Files`，含旧品牌目录名）；
4. 候选目录必须**真实存在且含主程序 exe** 才采用。

用户仍可在目录页修改；命令行 `/D=` 优先级最高。

### 实测
- 本机注册表实跑：HKCU 26 个卸载条目中命中并解析出 `D:\dsh\DeepSeek Agent`（该条目没有 `InstallLocation`，走的是 `DisplayIcon` 反推路径）✓
- NSIS 脚本用 makensis 3.0.4.1 独立编译通过 ✓
- ⚠️ 脚本必须保存为 **UTF-8 带 BOM**（makensis 遇到无 BOM 的非 ASCII 源码会报 `Bad text encoding` 中断打包；文件头已写明）

## 说明
- 本版仅改安装器行为，应用内核/插件与 v1.2.0 相同（内核 0.1.5-rc.2 全锁步组）
- 品牌标识统一 LJANX / ljanx（v1.2.0 起）；升级步骤见 v1.2.0 说明
