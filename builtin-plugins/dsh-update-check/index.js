// dsh-update-check — host half is intentionally empty.
// 全部行为在客户端半边（client.js）：往侧栏左下角的 sidebar.footer.action
// 槽位注册一个按钮，通过 preload 暴露的 window.jackdshNative.update.*
// 让主进程去查 GitHub Release、下载安装包、启动安装程序。
//
// 宿主侧不需要任何能力（不占端口、不读文件、不注入 webServer 路由），
// 因此 inject 为空数组，与 dsh-cmdj-toggle 同构。

export const name = 'dsh-update-check'
export const inject = []

export function apply() {}
