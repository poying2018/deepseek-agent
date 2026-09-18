# DeepSeek Agent v1.2.2

## 🐛 修复：Jet Hub 登录时同时弹出两个浏览器

### 现象
在 Jet Hub 面板点「添加账号」登录时，会同时出现两个浏览器 —— 一个是真浏览器，另一个是**应用自己变成了登录页**。

### 根因（两处叠加）
1. **插件客户端兜底把主窗口导航成了登录页**
   `dsh-codearts-auth` 的客户端 (`lib/client/jet-hub.js`) 用 `window.open(loginUrl)` 打开登录页。宿主主进程的 `windowOpenHandler` 会把 http(s) 交给系统浏览器并**拒绝应用内窗口** → `window.open` 返回空 → 插件随后执行 `window.location.href = loginUrl` 兜底，**把应用主窗口整页导航成第三方登录页**。用户看到的就是「应用里又开了个浏览器」。
2. **codearts 的宿主与客户端各开一次**
   codearts 登录流程在宿主侧 (`lib/login.js`) 自己会用系统浏览器打开一次，客户端又开一次 → 系统浏览器**两个标签页**。
   （buddy / workbuddy 的宿主传的是空 opener，只靠客户端开 —— 所以不能无脑删客户端的 `window.open`，否则这两个 provider 会一个都不开。）

### 修复
- **构建期插件补丁**（`prepare-bundle` 新增 `PLUGIN_RUNTIME_PATCHES`，幂等、锚点失配只告警）：
  - 客户端不再把应用窗口导航到登录页（去掉 `window.location.href = loginUrl` 兜底）；
  - 宿主 codearts 登录流程改为空 opener，把「打开登录页」统一交给客户端那一次。
- **主进程加固**：新增 `will-navigate` 拦截 —— 应用窗口**绝不导航到外部站点**，一律转交系统浏览器；同源（内核页面/前端路由）照常放行。这样即使其他插件用同样的兜底写法，也不会再把主窗口变成浏览器。

### 结果
任何 provider（codearts / buddy / workbuddy）登录时，**恰好打开一个系统浏览器**，应用内不再出现任何浏览器窗口。

## 说明
- 本版是在 v1.2.1（安装器智能识别已有安装目录）基础上的一次行为修复，内核/插件版本不变。
- 品牌标识统一 LJANX / ljanx；升级步骤见 v1.2.0 说明。
