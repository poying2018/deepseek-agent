const { contextBridge, ipcRenderer } = require('electron')

// 暴露只读 native 窗口能力（备用）+ 应用内更新能力
try {
  contextBridge.exposeInMainWorld('jackdshNative', {
    toggleMaximize: () => ipcRenderer.send('jackdsh:window-toggle-maximize'),

    /**
     * 应用内更新。全部走主进程（渲染层不碰网络与文件系统）。
     *
     * 注意：只有**桌面客户端**里的页面才有这个对象。用手机通过局域网遥控
     * 打开同一页面时 window.jackdshNative 不存在 —— 客户端插件必须自行降级。
     */
    update: {
      /** 当前版本 / 发布页地址 / 已下载的安装包 / 平台信息 */
      info: () => ipcRenderer.invoke('jackdsh:update-info'),
      /** 查询 GitHub 最新 Release 并与本机版本比对 */
      check: () => ipcRenderer.invoke('jackdsh:update-check'),
      /** 下载指定资产（asset 来自 check 的返回） */
      download: (asset) => ipcRenderer.invoke('jackdsh:update-download', asset),
      /** 启动已下载的安装程序 */
      install: (filePath) => ipcRenderer.invoke('jackdsh:update-install', filePath),
      /** 用系统浏览器打开发布页 */
      openReleases: () => ipcRenderer.invoke('jackdsh:update-open-releases'),
      /**
       * 订阅下载进度。
       * @returns 取消订阅函数（组件卸载时必须调用，否则监听器会堆积）
       */
      onProgress: (callback) => {
        if (typeof callback !== 'function') return () => {}
        const listener = (_event, progress) => callback(progress)
        ipcRenderer.on('jackdsh:update-progress', listener)
        return () => ipcRenderer.removeListener('jackdsh:update-progress', listener)
      },
    },
  })
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
        ipcRenderer.send('jackdsh:window-toggle-maximize')
        return
      }

      // 真正需要阻止双击缩放的交互元素：输入框、下拉框、Tab、非标题的操作按钮、关闭叉等
      const isInteractive = target.closest(
        'input, select, textarea, [role="menuitem"], [role="combobox"], [class*="iconButton"], [class*="close"], [class*="tab"]:not([class*="crumbCurrent"]), button:not([disabled]), a[href]'
      )
      if (isInteractive) return

      // 在顶栏任意空白处、文字间隙双击，安全触发窗口缩放
      ipcRenderer.send('jackdsh:window-toggle-maximize')
    },
    { capture: true }
  )
})
