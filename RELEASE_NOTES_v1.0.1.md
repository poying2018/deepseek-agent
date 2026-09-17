# DeepSeek Agent v1.0.1

## 账号接入变更
- **用 `dsh-codearts-auth` 替换了 `dsh-connect-workbuddy`**。新插件由 iJetLi 维护（MIT，Gitee 源），一次集成同时支持三套账号体系：
  - **CodeArts**（华为云 IAM OAuth，本地回调 + STS 临时凭证刷新）
  - **Buddy**（腾讯 CodeBuddy 国内版，外链轮询登录 + 账号池 + 每日签到 + 积分）
  - **WorkBuddy**（国际版，同一协议，`www.workbuddy.ai`）
  - 三者共用 Jet Hub 设置页面板，不再单独占一个侧栏按钮。
- 新增 **`dsh-connect-trae`**（dingminhua，MIT，npm 1.3.0 固定版本）——Trae 账号接入。

## 说明
- 内核仍为 `@deepseek-ai/dsh` 锁步版本（`0.1.2-rc.1` 线），本次仅调整账号插件组合，无内核变更。
- 安装包由 CI 在打 `v1.0.1` tag 时自动构建并发布。
