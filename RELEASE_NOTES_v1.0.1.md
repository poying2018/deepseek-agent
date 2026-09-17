# DeepSeek Agent v1.0.1

## 更新模型简化：单轨更新
- **取消「应用本体 / 核心」双轨更新**。内核（@deepseek-ai/dsh 锁步包组）不再从 npm 运行期替换，而是**随安装包整体发布**——更新应用本体即更新内核。
- 这从根上消灭了运行期内核替换的整类故障（替换失败、回滚 EPERM、内核缺包起不来等），不再需要 `.dsh-core-backup`、待修复清单与启动冒烟验证那套兜底。
- 构建侧新增 `pnpm update-core`：一条命令把内核依赖升到 npm 最新并整组安装，之后正常打包即可。

## 账号接入变更
- **用 `dsh-codearts-auth` 替换了 `dsh-connect-workbuddy`**。新插件由 iJetLi 维护（MIT，Gitee 源），一次集成同时支持三套账号体系：
  - **CodeArts**（华为云 IAM OAuth，本地回调 + STS 临时凭证刷新）
  - **Buddy**（腾讯 CodeBuddy 国内版，外链轮询登录 + 账号池 + 每日签到 + 积分）
  - **WorkBuddy**（国际版，同一协议，`www.workbuddy.ai`）
  - 三者共用 Jet Hub 设置页面板，不再单独占一个侧栏按钮。
- 新增 **`dsh-connect-trae`**（dingminhua，MIT，npm 1.3.0 固定版本）——Trae 账号接入。

## 构建与 CI 修复
- 修复插件 `.npmrc` 里钉死的 `script-shell=cmd.exe` 让 CI 双平台构建哑火的问题（macOS 上 exit -2；Windows 上变成交互式 shell 静默退出、零产出）。
- 修复入口产物校验误把 `exports` 里的 glob（`./src/*`）与 `.d.ts` 当成必须构建的文件。

## 说明
- 「检查更新」面板与菜单现在只有应用本体一个轨道。
- 安装包由 CI 在打 `v1.0.1` tag 时自动构建并发布。
