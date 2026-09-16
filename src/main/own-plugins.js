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
  // 只挂 sidebar.footer.action 槽位 + 走 preload 的 window.jackdshNative.update.*，
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
  'dsh-connect-workbuddy',
]

export const ALL_BUILTIN_PLUGINS = [
  ...OWN_PLUGINS,
  ...COMMUNITY_PLUGINS,
]
