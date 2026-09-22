/**
 * 纯净版（vanilla 分支）插件清单：**三个列表全部为空**。
 *
 * 这个分支的目的只有一个：给出一个「只有官方内核本体」的可运行发行版，用来判断
 * 各种行为问题（输入框偶发不吃点击、长轮次、卡顿）到底是插件/皮肤叠出来的，还是
 * 上游内核本身就有的。所以：
 *
 *   · 不打包、不注册任何插件 —— profile 的 dsh.profile.bundles 里只剩
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
 * 导出名与主线保持一致，避免这个分支上还得改一堆 import。
 */

/** 自研插件：纯净版为空。 */
export const OWN_PLUGINS = []

/** 社区插件：纯净版为空。 */
export const COMMUNITY_PLUGINS = []

/** 随包分发但默认不启用的外观类插件：纯净版为空。 */
export const OPT_IN_PLUGINS = []

export const ALL_BUILTIN_PLUGINS = [
  ...OWN_PLUGINS,
  ...COMMUNITY_PLUGINS,
  ...OPT_IN_PLUGINS,
]
