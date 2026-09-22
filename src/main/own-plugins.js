/**
 * 纯净版（vanilla 分支）插件清单：**只有一个例外 —— 更新面板 dsh-update-check**。
 *
 * 这个分支的目的只有一个：给出一个「只有官方内核本体」的可运行发行版，用来判断
 * 各种行为问题（输入框偶发不吃点击、长轮次、卡顿）到底是插件/皮肤叠出来的，还是
 * 上游内核本身就有的。所以：
 *
 *   · 除更新面板外不打包、不注册任何插件 —— profile 的 dsh.profile.bundles 里只剩
 *     `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 两行内核本体；
 *   · 从主线升级上来的用户，profile 里残留的插件行与死链由
 *     ServerManager.initIsolatedProfile() 的失效清理自动剔除（这条自愈在主线就有，
 *     且被 pnpm check:profile 钉住）；应用内自装的插件包仍然能被识别为"用户自己的"
 *     而**不会**被删，只是不再默认启用；
 *   · 保留的东西（刻意选择）：三处内核包兼容补丁（设置页侧栏滚动、未鉴权模型隐藏、
 *     client-modules 启动提速）与外壳侧的启动/GPU 优化 —— 它们不引入功能、只修缺陷；
 *   · 去掉的东西（同样刻意）：所有插件，以及为插件服务的注入层 —— cordis 托管区里的
 *     repeat-tool-reminder 能力行、preload 的输入框点击兜底（它本身就在改交互行为，
 *     留在裸底里会污染对比结论）。目录选择器的 browse 两面与「关闭 client HMR」保留，
 *     因为它们不是插件，而是让 Electron-as-Node 宿主能选工作区、不被 SSE 连接耗尽
 *     拖死的最小适配。
 *
 * ── 为什么留着一个插件 ──────────────────────────────────────────────────────
 * 纯净版是 prerelease 轨道（tag 形如 v1.4.3-vanilla.1），而 GitHub 的
 * /releases/latest 端点结构上永不返回 prerelease —— 纯净版用户靠自己查不到
 * 本轨道的新版本，只能靠人工盯发布页。所以把「检查更新」这块面板留下。
 *
 * 它是**唯一**一个，而且刻意挑了副作用最小的那个：宿主半边 index.js 是空实现
 * （inject = []，不占端口、不读文件、不改 webServer 路由），客户端半边只往
 * sidebar.footer.action 槽位注册一个按钮，动作全走 preload 暴露的主进程 IPC。
 * 也就是说它不参与内核推理、不改交互行为，不会污染「这个毛病是不是插件造成的」
 * 这个本分支要回答的问题。真正会改变行为的插件（看门狗、输入框兜底、皮肤）
 * 依旧一个都不带。
 *
 * 导出名与主线保持一致，避免这个分支上还得改一堆 import。
 */

/** 自研插件：只剩更新面板（理由见文件头）。其余自研插件一律不带。 */
export const OWN_PLUGINS = [
  'dsh-update-check',
]

/** 社区插件：纯净版为空。 */
export const COMMUNITY_PLUGINS = []

/** 随包分发但默认不启用的外观类插件：纯净版为空。 */
export const OPT_IN_PLUGINS = []

export const ALL_BUILTIN_PLUGINS = [
  ...OWN_PLUGINS,
  ...COMMUNITY_PLUGINS,
  ...OPT_IN_PLUGINS,
]
