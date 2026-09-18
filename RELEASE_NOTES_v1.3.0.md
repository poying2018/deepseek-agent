# DeepSeek Agent v1.3.0

## 🆕 新增两个社区插件（默认集成并启用）

| 插件 | 作用 | 来源 |
|---|---|---|
| **dsh-damage-pulse** | Token 余额监控：鲸鱼娘待机/扣费/复苏动画、峰谷计费、连续扣费飘字、会话费用统计 | [wssfk12138/dsh-damage-pulse](https://github.com/wssfk12138/dsh-damage-pulse)（MIT） |
| **dsh-undo-savepoint** | 崩溃救援：配置与插件代码变更的可回滚快照、密钥安全、一键 SAFE MODE，以及 DSH 起不来时也能用的离线 CLI/GUI | [lire1131/dsh-undo-savepoint](https://github.com/lire1131/dsh-undo-savepoint)（MIT） |

两者都已进 `plugins.manifest.yaml`（CI 现场 clone 构建）与 `own-plugins.js`（运行期自动注册进隔离 profile），**装完即启用**。

### 依赖处理（自检结论）
| 依赖项 | 结论 |
|---|---|
| `zod`（damage-pulse 主机面 peer `^4.4.3`） | ✅ 本发行版已有 **4.5.4** |
| `qrcode`（damage-pulse 声明的 dependency） | ✅ **无需补装**：作者已把它打进 `lib/client.js`（261KB 自包含），运行期不 require |
| `@deepseek-ai/*` 各 peer（宿主/客户端模块） | ✅ 锁定版本 0.1.5-rc.2 全部落在声明的 OR 区间内 |
| `react` / `@deepseek-ai/dsh-client-ui-slots` | ✅ 由内核客户端运行期提供（`react` 非 node_modules 包；`slots` 与 trae 插件同一注入形态，实测在客户端批次清单里正常解析） |
| `dsh-undo-savepoint` | ✅ 零 dependencies / peerDependencies，只用 node 内置模块 |

### 打包瘦身
`dsh-damage-pulse` 仓库的 `docs/`（31MB 文档截图）运行期不引用（`lib` 只引用 `assets/`），
新增逐插件裁剪表 `PLUGIN_PRUNE_DIRS` 排除它：插件体积 **54MB → 23MB**。

### 本机验证（实机日志）
```
[dsh-token-monitor] plugin loaded
[dsh-token-monitor] 使用 settings 价格表 v2026-09-13 / 每日预算 CNY 10.00
[dsh-token-monitor] charge-events / wechat connection / settings / asset / balance 路由已注册
[dsh-token-monitor] 已为 2 个历史会话重建 tokenCost 投影
[dsh-token-monitor] 余额 CNY 3.14（赠送 0.00 / 充值 3.14）
```
客户端两个插件的 `client.js` 均已出现在内核分批下发的模块清单中；启动后**零错误**。

## 说明
- 本版起安装包体量约 +24MB（damage-pulse 的资产与动画资源）。
- 累计的插件侧构建补丁（`PLUGIN_RUNTIME_PATCHES`）：codearts-auth / dashboard / archive-manager / web-search-follow。
