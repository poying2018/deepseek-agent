# DeepSeek Agent v1.3.3 发布说明 — 换肤能力开箱可用 + 打包工具链修复

> 本版同时包含 **v1.3.2 的全部内容**（v1.3.2 未单独发布：Chromium CPU 空闲占用深度削减 + 内置
> `dsh-provider-qoder`）。如果你从 v1.3.1 升级，两件事都会拿到。

## 🎨 新增：换肤三件套随包分发

内置三个社区皮肤/主题插件，**默认不启用**，在插件面板里自行打开（打开后重启或刷新页面生效）：

| 插件 | 作用 |
| :--- | :--- |
| `dsh-dream-skin` 9.16.0 | 8 套 iOS / Linear 式清透冷调主题 + 弥散光壁纸 + 强调色 + 主题包分享 |
| `dsh-client-ui-seaglass` 1.6.7 | 玻璃拟态主题，模糊/霜化/圆角/动效均可调 |
| `dsh-skin-manager` 0.1.6 | 皮肤发现与互斥切换的独立设置页（含"恢复官方外观"） |

三者都钉 npm 发行包版本随安装包分发，安装后无需联网。之所以默认关：外观类插件一挂载就改界面，
「随包有什么」和「默认开什么」是两件事。

### 顺带修好一个会整屏白屏的坑

`dsh-skin-manager` 的客户端 bundle 硬 `require` 了 `@deepseek-ai/dsh-client-runtime/client`，
而平台早已把 `dsh-client-runtime` 拆成 `dsh-client-modules` / `dsh-client-store` /
`dsh-client-locale` 并冻结了浏览器侧的平台模块表 —— 该说明符在现行内核里**无解**，必然抛
`missed the module table`。后果不止它自己：**任一模块导入失败会中止整个 Web 壳启动**，
用户看到满屏 "Failed to load plugins"，连会话界面一起没了。

本版在发行版侧把它改指后继模块 `dsh-client-store`（实测该变量在该插件里赋值后从未被使用，
属上游构建残留的死引用，改动零语义风险）。

## 🔧 修复：第三方插件的兼容补丁以前管不到你装的插件

原先插件兼容补丁只在**构建打包时**改写随包插件，用户从应用内安装的第三方插件走的是另一条路径，
补丁根本碰不到 —— 也就是说这类修复只对我们自己带的插件生效。

现在补丁表抽成宿主与构建期共用的同一份清单，**每次启动**都会对应用内安装的第三方插件按同一张表
过一遍（幂等，锚点失配只记一条警告不阻断启动）。以后新收录的社区插件兼容问题都能自动覆盖到。

## 🛠 修复：内核升轨工具链

`pnpm update-core` 之前取的是 npm 的 `latest` 标签，而本发行版本就钉在 `latest` 上 —— 等于**跑了什么都不升**。
现改为按 dist-tag 选轨，并且把 pnpm 的两份 overrides 一起带走：

```bash
pnpm update-core                     # latest（默认）
pnpm update-core -- --tag alpha      # alpha 轨道
pnpm update-core -- 0.1.6-alpha.2    # 显式版本
pnpm update-core -- --sync-only      # 只把两处 overrides 对齐到当前钉版，不动版本
pnpm update-core -- --dry-run        # 只打印计划，不写文件
```

同时修掉一处已经漂移了的实际缺陷：`pnpm-workspace.yaml` 的 overrides 还停在 `0.1.2-rc.1`
（`package.json` 侧是 `0.1.5-rc.2`），并且少 6 个条目。CI 用 pnpm 10 读前者所以没受影响，
但本地用 pnpm 11+ 装就会把 `dsh-llm` / `dsh-session-query` 等一批包拉回旧版 ——
表现为缺导出的启动崩溃。现在脚本负责让两侧**永远逐条相等**，不一致直接拒绝继续。

## ⚠️ 已知：`dsh-codex-timeline` 随包但被停用

它显式声明"仅验证到内核 0.1.2-alpha.3"，本发行版内核是 0.1.5-rc.2，
打包时的内核兼容性门禁会把它改名为 `.disabled-…` 让运行期失效。
这不是本版引入的行为，列在这里以免你在插件列表里找不到它。

## 验证

- 换肤三件套的 peer 声明逐条比对通过（`check-plugin-peers`）。
- 打包路径两种都跑通：`prepare-bundle --source auto` 与 CI 同路径的 `--source public`（清空插件缓存）。
- Windows 安装包本地构建通过：`DeepSeek-Agent-1.3.3-Windows-Setup.exe`（约 218 MB）。
- `update-core` 四条参数路径 + 连续两次 `--sync-only` 的产物逐字节一致。
