# DeepSeek Agent v1.2.5

## 🐛 修复：联网搜索在非 Grok/Gemini/DeepSeek 模型下完全不可用

### 现象
用 Jet Hub 接进来的模型（**WorkBuddy / CodeBuddy / CodeArts / Trae**）时，联网搜索（web_search）直接报错：

```
follow-search: provider "workbuddy" has no native search adapter yet
(supported: Grok, Gemini, DeepSeek). Do not fall back across unrelated providers.
```

### 根因（两处）
| # | 位置 | 问题 |
|---|---|---|
| 1 | `dsh-web-search-follow/index.js` | 搜索适配器**只认 Grok / Gemini / DeepSeek 三种模型路由**；其它 provider 一律抛错（作者原意是「不跨服务商乱回退」）。而本发行版默认模型是 `workbuddy`，于是搜索必然失败。 |
| 2 | `dsh-web-search-follow/deepseek.js` | 取 DeepSeek API key 的兜底路径**硬编码 `~/.dsh/.credentials.yaml`**，忽略本发行版给内核设置的隔离 `DSH_HOME`，且与新版凭据存储格式不匹配。 |

### 修复（构建期插件补丁）
1. **未适配模型改为回退 DeepSeek 官方搜索**：用用户自己的 `DEEPSEEK_API_KEY`、DeepSeek 侧默认模型（与当前聊天模型无关），不再报错；仍然只走用户自己的额度，不跨服务商乱花。
2. **凭据路径优先隔离 `DSH_HOME`**（`JACKDSH_HOME` 兼容），找不到才退回 `~/.dsh`。

### 验证（本机实测）
用真实凭据跑了一次真实搜索：
```
query: "DeepSeek Harness 是什么"
→ ✅ 返回 5 条来源（中国证券网 / 新浪财经 / 阿里云开发者社区 / 网易 …）
```

## 说明
- 本版累计的插件侧构建补丁（`PLUGIN_RUNTIME_PATCHES`，表驱动幂等）：
  `dsh-codearts-auth`（登录只开一个系统浏览器）、`dsh-plugin-dashboard`（版本号读取）、
  `@mlgbnb/dsh-archive-manager`（归档列表/详情）、`dsh-web-search-follow`（搜索回退 + 凭据路径）。
- 另：`dsh plugin --profile web add dsh-web` 依旧不会生效 —— npm 上不存在名为 `dsh-web` 的包；
  `@deepseek-ai/dsh-web` 是内核 `ctx.web` 的服务行（已在托管区显式启用），工具层由 Agent 预设的 `tool-web` 挂载。
