/**
 * 精选自研插件清单（构建期复制进 bundle-runtime/plugins，运行期注册进隔离 profile）。
 * 准入标准：纯源码可直跑、依赖能被 App 内置 hoisted node_modules 覆盖
 * （undici / @earendil-works/pi-ai / @deepseek-ai/* / react 等），
 * 不含原生编译模块（如 node-pty），保证 Electron-as-Node 运行时可直接加载。
 */
export const OWN_PLUGINS = [
  'dsh-mobile-plus',
  'dsh-gemini-oauth',
  'dsh-grok-oauth',
  'dsh-deepseek-balance',
  'dsh-today',
  'dsh-web-restart',
  'dsh-workspace-path',
  'dsh-robust-search',
  'dsh-reminder',
  'dsh-app-badge',
  'dsh-session-navigator',
  'dsh-plugin-dashboard',
  'dsh-web-search-follow',
  'dsh-better-sidebar',
  'dsh-paste-path',
  'dsh-autostart',
  // 这两个此前只在 plugins.manifest.yaml 里（会被打进包）却没进本清单，
  // 结果是「装了但永不注册」。两者都为纯 JS、无任何 dependencies / peerDependencies，
  // 服务端 inject 均为空数组，注册不存在缺依赖失败的风险：
  //   · dsh-browser-attach —— 按需拉起本地 browserctl daemon（127.0.0.1:9223），
  //     把 browser_* 工具接到用户真实 Chrome 的常驻 CDP 连接上，未调用时不占资源；
  //   · dsh-cmdj-toggle    —— host 半边是空实现，全部行为在 client.js
  //     （页面级热键，合成点击 dsh-better-sidebar 自己的切换按钮）。
  'dsh-browser-attach',
  'dsh-cmdj-toggle',
  // 仓内第一方插件（源码在 builtin-plugins/，不依赖外部 repo）。
  // 只挂 sidebar.footer.action 槽位 + 走 preload 的 window.ljanxNative.update.*，
  // 宿主半边为空实现，无依赖：
  //   · dsh-update-check —— 左下角「检查更新」：查 GitHub Release、显示更新说明、
  //     应用内下载安装包并启动安装程序。
  'dsh-update-check',
  //   · dsh-runaway-guard —— 单轮失控看门狗。内核没有任何步数上限（dsh-agent-loop
  //     只有 maxParallelToolCalls），所以失控轮只能靠 agent/pre-step 这道现成的
  //     waterfall 拦：超阈值先追加一条 plugin 署名的收尾指令，再放行 graceSteps 步
  //     仍不收就返回 {kind:'reject'}，让 turn/end 以 'blocked' 干净结束。
  //     零依赖（不 import @deepseek-ai/*），只读 payload 与 session.ownEvents()。
  //     阈值可在 settings.yaml 的 dsh-runaway-guard 段覆盖，也可用
  //     DSH_RUNAWAY_GUARD* 环境变量整体关掉（DSH_RUNAWAY_GUARD=0）。
  'dsh-runaway-guard',
]

/**
 * 精选社区开源插件（同样内置预装进一键安装包，开箱即用）
 */
export const COMMUNITY_PLUGINS = [
  '@mlgbnb/dsh-archive-manager',
  'dsh-codex-timeline',
  '@wxg-prc-cpg/browser-skill-dsh-plugin',
  // 一顶三的账号接入插件（作者 iJetLi，MIT；源在 Gitee，见 plugins.manifest.yaml 的
  // 详细注释）：codearts（华为云 CodeArts）+ buddy（腾讯 CodeBuddy 中国版）+
  // workbuddy（WorkBuddy 国际版）三个 LLM provider，自带浏览器登录、静默续期、
  // Jet Hub 账号池 / 积分签到 / 模型开关。取代了原先的 dsh-connect-workbuddy
  // （dingminhua v2.0.1，workbuddy provider 由它接管，凭据 ref 同名兼容）。
  // peerDependencies 明写 ^0.1.2-rc.1，与本发行版内核精确匹配；运行时依赖 jose，
  // 宿主 node_modules 已有（6.2.10 ≥ ^6.1.3）。
  'dsh-codearts-auth',
  // 同族：把本机 Trae 账号接成 DSH 的 LLM provider（作者 dingminhua，MIT）。
  // 钉 npm 发行包 1.3.0 而非 latest(2.0.4)：2.x 要求内核 >=0.1.5-0 且 pi-ai >=0.85.1，
  // 而本发行版是 0.1.2-rc.1 + pi-ai 0.84.4，装了会在运行期挂。
  // 1.2.0 的 CHANGELOG 明写「适配 DSH v0.1.2-rc.1 上游重构」，1.3.0 只是在其上加
  // 模型名内嵌积分倍率，故取 1.3.0。
  'dsh-connect-trae',
  // ── 社区插件（作者独立仓库，MIT，源见 plugins.manifest.yaml）───────────────
  //   · dsh-damage-pulse  —— Token 余额监控：鲸鱼娘待机/扣费/复苏动画、峰谷计费、
  //     连续扣费飘字、会话费用统计。宿主面只依赖 zod（本发行版已有 4.5.4 ✅）；
  //     其 declared dependency qrcode 已被作者打进客户端 bundle，运行期不 require ✅。
  //   · dsh-undo-savepoint —— 崩溃救援：配置/插件代码变更的可回滚快照、密钥安全、
  //     一键 SAFE MODE，以及 DSH 起不来时也能用的离线 CLI/GUI。零依赖 ✅。
  'dsh-damage-pulse',
  'dsh-undo-savepoint',
  // Qoder provider（作者 mo-n）2026-09-19 起移出发行版：它接的是别人账号体系的
  // 适配层，随包默认启用等于替一个我们不维护的插件背书；需要的人在应用内从 npm 自装。
]

/**
 * 随包分发但**默认不启用**的插件（装进 runtime/plugins 并建好解析链接，但不写进
 * dsh.profile.bundles）。用户在插件面板里自己打开，内核会把名字加进 bundles。
 *
 * 这一档存在的理由：外观类插件一旦默认挂载就直接改全体用户的界面，而「内置了什么」
 * 与「默认开什么」是两件事。皮肤三件套因此放这里，而不是 COMMUNITY_PLUGINS。
 */
export const OPT_IN_PLUGINS = [
  // 换肤三件套（各自独立仓库，见 plugins.manifest.yaml 的来源与依赖自检注释）：
  //   · dsh-dream-skin       —— 8 套 iOS/Linear 式冷调主题 + 壁纸 + 强调色（RevolutionLA）
  //   · dsh-client-ui-seaglass —— 玻璃拟态主题，可调模糊/霜化/圆角/动效（xiyunyunyun）
  //   · dsh-skin-manager     —— 皮肤发现与互斥切换的设置页（xiaoyangcheng84-svg）
  // 三者对宿主 seed 表的依赖已在 0.1.5-rc.2 上逐个核对过；skin-manager 的死引用
  // 由 plugin-compat.js 的补丁处理（不修它会整壳白屏，不是只坏它自己）。
  'dsh-dream-skin',
  'dsh-client-ui-seaglass',
  'dsh-skin-manager',
]

export const ALL_BUILTIN_PLUGINS = [
  ...OWN_PLUGINS,
  ...COMMUNITY_PLUGINS,
  ...OPT_IN_PLUGINS,
]
