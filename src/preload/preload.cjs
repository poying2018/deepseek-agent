const { contextBridge, ipcRenderer } = require('electron')

// 暴露只读 native 窗口能力（备用）+ 应用内更新能力
try {
  const bridge = {
    toggleMaximize: () => ipcRenderer.send('ljanx:window-toggle-maximize'),

    /**
     * 应用内更新。全部走主进程（渲染层不碰网络与文件系统）。
     *
     * 注意：只有**桌面客户端**里的页面才有这个对象。用手机通过局域网遥控
     * 打开同一页面时 window.ljanxNative 不存在 —— 客户端插件必须自行降级。
     */
    update: {
      /** 当前版本 / 发布页地址 / 已下载的安装包 / 平台信息 */
      info: () => ipcRenderer.invoke('ljanx:update-info'),
      /** 查询 GitHub 最新 Release 并与本机版本比对 */
      check: () => ipcRenderer.invoke('ljanx:update-check'),
      /** 下载指定资产（asset 来自 check 的返回） */
      download: (asset) => ipcRenderer.invoke('ljanx:update-download', asset),
      /** 启动已下载的安装程序 */
      install: (filePath) => ipcRenderer.invoke('ljanx:update-install', filePath),
      /** 用系统浏览器打开发布页 */
      openReleases: () => ipcRenderer.invoke('ljanx:update-open-releases'),
      /**
       * 订阅下载进度。
       * @returns 取消订阅函数（组件卸载时必须调用，否则监听器会堆积）
       */
      onProgress: (callback) => {
        if (typeof callback !== 'function') return () => {}
        const listener = (_event, progress) => callback(progress)
        ipcRenderer.on('ljanx:update-progress', listener)
        return () => ipcRenderer.removeListener('ljanx:update-progress', listener)
      },
    },

    /**
     * 左上角菜单「检查更新」→ 让面板打开。
     * 返回取消订阅函数。
     */
    onOpenPanel: (callback) => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, tab) => callback(tab)
      ipcRenderer.on('ljanx:update-open-panel', listener)
      return () => ipcRenderer.removeListener('ljanx:update-open-panel', listener)
    },
  }

  contextBridge.exposeInMainWorld('ljanxNative', bridge)
  // 旧名兼容：上游社区插件（dsh-app-badge / dsh-mobile-plus / dsh-plugin-dashboard
  // 等 JackAIStudio 仓库）用 `window.jackdshNative` 探测「是否在桌面客户端里」，
  // 并据此切换行为。改名后保留同名桥，避免这些插件退化成「非桌面」分支。
  // TODO: 待上游插件改用 window.ljanxNative 后可移除。
  contextBridge.exposeInMainWorld('jackdshNative', bridge)
} catch {}

// 智能监听窗口顶部双击事件：彻底保障「双击变大变小」100% 随时随地生效
window.addEventListener('DOMContentLoaded', () => {
  window.addEventListener(
    'dblclick',
    (e) => {
      // 仅响应顶部 48px 区域内（沉浸式顶栏与侧栏头部区域）
      if (e.clientY > 48) return

      const target = e.target
      if (!target || !target.closest) return

      // 如果双击在模态弹窗内（设置面板、确认框等），不触发缩放
      if (target.closest('[role="dialog"], [aria-modal="true"]')) {
        return
      }

      // 当前会话标题（crumbCurrent 或 disabled 的展示标题）属于标题栏核心，允许双击缩放
      const isCurrentTitle = target.closest('[class*="crumbCurrent"], button[class*="crumb"][disabled]')
      if (isCurrentTitle) {
        ipcRenderer.send('ljanx:window-toggle-maximize')
        return
      }

      // 真正需要阻止双击缩放的交互元素：输入框、下拉框、Tab、非标题的操作按钮、关闭叉等
      const isInteractive = target.closest(
        'input, select, textarea, [role="menuitem"], [role="combobox"], [class*="iconButton"], [class*="close"], [class*="tab"]:not([class*="crumbCurrent"]), button:not([disabled]), a[href]'
      )
      if (isInteractive) return

      // 在顶栏任意空白处、文字间隙双击，安全触发窗口缩放
      ipcRenderer.send('ljanx:window-toggle-maximize')
    },
    { capture: true }
  )

  // 设置中心侧边栏滚动防护：当插件众多时保证侧栏列表可顺畅垂直滚动
  const styleId = 'ljanx-settings-nav-scroll-fix'
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      [role="dialog"] nav,
      [aria-modal="true"] nav,
      nav[class*="_nav"] {
        height: 100% !important;
        max-height: 100% !important;
        min-height: 0 !important;
        overflow: hidden !important;
        display: flex !important;
        flex-direction: column !important;
        box-sizing: border-box !important;
        padding-bottom: 0 !important;
      }
      [role="dialog"] nav > div:first-child,
      [class*="_navTitle"] {
        flex: none !important;
      }
      [role="dialog"] nav > div:last-child,
      [class*="_navList"] {
        flex: 1 1 auto !important;
        min-height: 0 !important;
        overflow-y: auto !important;
        overflow-x: hidden !important;
        overscroll-behavior: contain !important;
        display: flex !important;
        flex-direction: column !important;
        gap: 4px !important;
        padding-bottom: 22px !important;
      }
      [role="dialog"] nav button,
      [class*="_navCell"] {
        padding-right: 12px !important;
      }
    `
    document.head.appendChild(style)
  }

  // 滚轮穿透：在设置侧栏标题等非列表区域滚动时，自动转发给列表
  window.addEventListener(
    'wheel',
    (e) => {
      const dialog = e.target?.closest?.('[role="dialog"], [aria-modal="true"]')
      if (!dialog) return
      const nav = dialog.querySelector('nav')
      if (!nav || !nav.contains(e.target)) return
      const navList = nav.querySelector('[class*="navList"]') || nav.lastElementChild
      if (!navList || navList.contains(e.target)) return
      navList.scrollTop += e.deltaY
    },
    { passive: true }
  )

  // ── 窗口不可见时冻结 CSS 动画（GPU / 电量）──────────────────────────────
  // 主题插件（玻璃拟态那几套）在页面上挂了大量**常驻**动画：全屏环境层的呼吸、
  // 水母/气泡/浮游生物的无限位移等。窗口被最小化或被完全遮挡时这些动效一个像素都
  // 看不到，但合成器仍会按帧推进 —— 纯浪费。
  //
  // 为什么不能只靠 Chromium 自己节流：本发行版为了保住 Token 轮询等后台任务，
  // 显式关掉了 renderer/occluded 的后台化（见 src/main/index.js 的 anti-throttle），
  // 代价就是"看不见时也照画"。这里用 CSS 层面兜回来：不可见时把所有动画暂停
  // （animation-play-state 只冻结推进，不改布局，恢复后从当前帧继续，无跳变）。
  const pauseId = 'ljanx-hidden-pause-anim'
  const syncPauseStyle = () => {
    const existing = document.getElementById(pauseId)
    if (document.hidden) {
      if (existing) return
      const style = document.createElement('style')
      style.id = pauseId
      style.textContent =
        'html *, html *::before, html *::after { animation-play-state: paused !important; }'
      document.head.appendChild(style)
    } else if (existing) {
      existing.remove()
    }
  }
  document.addEventListener('visibilitychange', syncPauseStyle)
  syncPauseStyle()

  // ── 输入框点击兜底 + 无响应归因 ──────────────────────────────────────────
  // 逻辑与成因都在 ./composer-guard.cjs（纯函数，可被 pnpm check:composer 用假 DOM 断言）。
  // 这里只负责注入真实环境与"把归因交给主进程落盘"：渲染层不碰文件系统。
  // 载荷是一组封闭的属性名/枚举值，不含任何用户输入内容（白名单由测试钉住）。
  try {
    const { installComposerGuard } = require('./composer-guard.cjs')
    installComposerGuard({
      window,
      document,
      send: (payload) => {
        try { ipcRenderer.send('ljanx:composer-diag', payload) } catch {}
      },
    })
  } catch (error) {
    console.error('[composer-guard] 装载失败，输入框兜底不可用:', error && error.message)
  }
})
