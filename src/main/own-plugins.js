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
  'dsh-web-search-follow',  'dsh-better-sidebar',
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
]

export const ALL_BUILTIN_PLUGINS = [
  ...OWN_PLUGINS,
  ...COMMUNITY_PLUGINS,
]
