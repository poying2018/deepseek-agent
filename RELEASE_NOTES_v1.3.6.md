# DeepSeek Agent v1.3.6 发布说明 — 交互修复 + 模型列表收敛 + 性能

本版处理五件事：新建会话点输入框没反应、未鉴权第三方模型刷屏、启动链路里的无效 I/O、
玻璃拟态主题的 GPU 占用、以及 CodeArts 登录流程被上游重构打哑的兼容补丁。

## 🐛 修复：新建对话时点击输入框没反应

现象是新建会话后点输入框（或输入框周围那圈留白）拿不到焦点、打不了字。

根因是**命中测试被上层元素截走**：主题/插件会在内容区叠定位层（光标 spotlight、全屏环境层、
面板包裹层等），或者 composer 自己的内边距不转发点击 —— 点击落在输入框的矩形内，事件目标
却是别的元素，于是焦点永远不会落到输入域上。

修法在 `src/preload/preload.cjs` 里做了**两条克制的兜底**（不拦事件、不改 DOM）：

1. 点击点落在某个 `textarea / [contenteditable]` 的矩形**之内**、但事件目标不是它 ⇒ 补一次 `focus()`；
2. 点击点落在 composer 容器（`[data-dsh-inputbar]` 或类名含 `inputbar` 的祖先）的留白上 ⇒ 把焦点转给容器里的输入域。

已经点在真正的交互元素（按钮/链接/输入框本身/弹窗内）时一律放行，不干扰正常行为。

## 🎛 变更：未完成鉴权的第三方模型默认从选择器隐藏

模型选择器的目录由内核 `buildModelCatalog()` 组装，它对**所有已注册适配器**的 provider 一律照单全收
—— 与该 provider 到底有没有登录过无关。于是没登录过 trae / grok / qoder 的用户，列表里照样有一堆
选了也发不出消息的「幽灵模型」。

现在宿主壳在**启动内核之前**算出「未鉴权」名单，经环境变量 `LJANX_HIDDEN_MODELS` 交给内核，
内核侧按 provider 过滤选择器里的分组。三条边界：

- **只影响选择器可见性**。模型目录本就是 advisory（上游注释明写 membership 不控制路由与请求校验），
  设置页的 Models 页仍列出全部 provider，供用户去登录 / 配 key；
- **当前默认模型所属的 provider 永远保留**，避免选择器出现「没有选中项」；
- 环境变量为空串时行为与上游**完全一致**（名单为空则整段短路）。

判定是保守的（`src/main/model-visibility.js`）：只考察已知需要鉴权的第三方 provider，命中
「jet-hub 账号池里有启用的账号 / 凭据文件里有它的条目 / 数据目录里有它的 OAuth 文件」任一信号就**保留**。
解析全部不抛异常，读不到就退回「不隐藏」。本机实测：隐藏 `trae, grok, qoder`，保留
`codearts, buddy, workbuddy, lobsterai, gemini`。同时会在数据目录写一份
`ljanx-hidden-models.json` 供排查。

## ⚡ 性能：启动链路 + 主题插件的 GPU 占用

**启动**：兼容补丁链每次启动都要跑（第三方插件构建期看不到），而幂等判断原先是「把目标文件整份读进来
看有没有补过」—— seaglass / dream-skin 的 client.js 各 350～390KB，光"确认已打过"就要读掉一两兆，
全部发生在**内核 spawn 之前**，直接叠进启动时间。现在加了一层**戳记**（`.ljanx-compat-stamp.json`）：
记下补丁表签名与每个目标文件的 `size+mtime`，没变就只 `stat` 不读，**一个字节都不读**；
文件变了（插件升级/被手改）则自动走回完整校验，不会漏打。另外：
- 窗口启动期会先后加载**两个文档**（启动占位页 → 内核真实页），原先 `dom-ready` 与 `did-finish-load`
  各注入一次 CSS，同一段规则在真实页上被插了两遍；现在收敛为「每文档一次」，并跳过占位页（`data:` URL）。

**主题插件**（玻璃拟态那几套，默认不启用，用户自选）：

- 移除了 Chromium 的 `disable-backgrounding-occluded-windows`。它会让「被别的窗口完全盖住」的窗口
  仍被当作可见，于是 `requestAnimationFrame` 照常推进 —— 而玻璃主题在页面上挂了整屏 30fps 的流体
  canvas 和常驻动画，被遮挡时继续按帧渲染等于纯烧 GPU。关掉后：被遮挡/最小化时渲染停摆，
  而 `disable-background-timer-throttling` 仍生效，Token 轮询、计费监控不受影响。
- 补丁把主题的**默认值**调成 GPU 友好（用户在设置页里改过的值不受影响）：
  seaglass 玻璃模糊 20px → 12px、默认关掉水母/气泡/浮游生物这五组纯装饰的 `infinite` 动画、
  关掉全屏环境层的不透明度呼吸动画；dream-skin 玻璃模糊 14px → 10px。
- preload 增加「窗口不可见时暂停全部 CSS 动画」（`animation-play-state: paused`），
  作为 CSS 层面的兜底：恢复时从当前帧继续，无跳变。

## 🔧 修复：CodeArts 登录流程的兼容补丁已失效（补丁锚点过期）

这是一条**静默失效**的补丁，值得单独记一笔。

`dsh-codearts-auth` 有两条登录路径：buddy / workbuddy 走「客户端开一次浏览器」，而
**codearts / lobsterai 的宿主 `startLogin()` 内部还会再开一次** ⇒ 系统浏览器被打开两个标签页。
用户在其中「先点到」的那个里完成授权时，回调可能落在另一个流程的 state 上，轮询永远等不到
完成，界面停在「等待授权」—— 表现就是「CodeArts 用不了」。

本项目早就针对这点打过补丁，但锚的是上游**旧结构**：
`const loginResult = await codearts.login({ refName, accountId: id, pool });`
上游把阻塞式 `login()` 换成两步式 `startLogin()` 之后，这个锚点**再也匹配不到**，补丁变成静默空转
（只留一条"未命中"告警），问题因此复发。本版把锚点对齐到当前结构（`startLogin({ refName })`），
并顺带给 lobsterai 打上同样的处理。

> 顺带修：内核自带包的运行期补丁此前在安装版里其实是**空转**的 —— 目录解析退回到了
> `app.asar` 内部（只读归档，写不进去）。现在改为对全部候选目录逐一尝试，并把
> `prepare-bundle` 的构建期补丁作为权威路径（它写仓库 `node_modules`，再由 electron-builder
> 经 `extraResources` 复制到 `resources/node_modules` —— 内核子进程真正加载的那一份）。

## 验证

- `check:picker` / `check:plugins` / `check:startup` 三项门禁全部通过。
- 12 条兼容补丁逐条对**本机实装文件**做了只读锚点校验：全部「可命中 / 已应用」，0 条失配。
- 模型可见性名单在真实 profile 上实测正确（见上文）。
- ⚠️ 本版改动覆盖主进程（preload / index / server-manager）⇒ **需完全退出后重新启动**才全部生效；
  页面刷新（Ctrl+R）不会重新加载主进程。
