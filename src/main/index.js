import { app, BrowserWindow, Menu, Tray, shell, dialog, clipboard, ipcMain } from 'electron'
import { existsSync, readFileSync, mkdirSync, renameSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFreePort } from './port-finder.js'
import { ServerManager, augmentGlobalPath } from './server-manager.js'
import {
  checkForUpdates,
  detectTrack,
  downloadUpdate,
  installUpdate,
  listDownloaded,
  openReleasesPage,
  openUninstallSettings,
  RELEASES_PAGE,
} from './updater.js'

// 内核（@deepseek-ai/dsh）不再有运行期更新轨道：它随安装包一起发布，
// 构建前用 `pnpm update-core` 把 package.json 里的内核依赖升到最新即可。

// 在启动初期增强 PATH，解决 macOS/Linux GUI 应用丢失终端环境变量的通病
augmentGlobalPath()

// ── 性能优化：GPU 与渲染线程调度（必须在 app.ready 之前设置）──────────────
// 本机为 AMD 780M 核显，调试日志确认 Chromium 已走 ANGLE/D3D11 硬件路径；
// 下面这组开关把 GPU 用得更满，并防止后台节流导致插件/计费监控卡顿。
//  - ignore-gpu-blocklist      ：解除对核显的 blocklist，强制走硬件而非 SwiftShader 软件渲染
//  - enable-gpu-rasterization  ：把图层光栅化也放到 GPU，降低 CPU 占用（鲸鱼娘动画/滚动更顺）
//  - disable-background-timer-throttling ：窗口失焦/被遮挡时，后台定时器不被降频到 1fps，
//                                保证 Token 监控、插件轮询等后台任务持续响应
//  - disable-renderer-backgrounding      ：渲染进程不被降级为后台优先级，避免长任务期间 UI 卡顿
//
// ⚠️ 这里**故意不**开 `disable-backgrounding-occluded-windows`（2026-09-19 移除）：
// 它会让「被别的窗口完全盖住」的窗口仍被当作可见，于是 requestAnimationFrame 照常推进。
// 玻璃拟态主题（dsh-client-ui-seaglass 等）在页面上挂了一整屏 30fps 的流体 canvas 和
// 环境层动画，被遮挡时继续按帧渲染就等于纯烧 GPU —— 而用户根本看不到。
// 关掉它之后：被遮挡/最小化时渲染停摆（省 GPU/电量），而定时器因上面那条仍不降频，
// Token 轮询、计费监控不受影响。
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// ── 性能优化：削减 Chromium 后台/空闲 CPU 空转 ──────────────────────────────
// 下面这组开关专门砍掉 Electron/Chromium 在「不忙着聊天」时也持续占用的 CPU：
// 后台网络心跳、组件自更新、遥测上报、翻译/媒体路由(投屏)发现、以及 Windows 原生窗口
// 遮挡计算（CalculateNativeWinOcclusion 在 AMD/N 卡上会周期性触发重绘风暴，是空闲 CPU 大户）。
// 注意：这些都不影响本应用自身的网络请求（LLM/工具调用走 renderer/node fetch，与
// background-networking 无关），也不影响我们自己的后台定时器（上面的 anti-throttle 仍生效）。
//  - disable-background-networking ：停掉 Chromium 自有后台网络（组件更新/安全浏览/连通性探测等心跳）
//  - disable-component-update      ：禁止组件后台自更新轮询
//  - disable-default-apps          ：不预拉取默认应用清单
//  - disable-extensions            ：本应用不用扩展，关掉扩展子系统常驻
//  - disable-sync                  ：关闭 Chrome 同步（无账号体系，纯省 CPU）
//  - disable-translate             ：关闭内置翻译服务
//  - disable-metrics               ：关闭遥测录制与上报
//  - disable-features             ：关掉会偷偷吃 CPU 的特性
//       · CalculateNativeWinOcclusion ：Windows 原生遮挡计算（空闲 CPU 大户）
//       · Translate / BackForwardCache / MediaRouter / OptimizationHints /
//         DocumentPictureInPicture ：翻译、BF 缓存、投屏(mDNS/SSDP)发现、优化提示、画中画
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-default-apps')
app.commandLine.appendSwitch('disable-extensions')
app.commandLine.appendSwitch('disable-sync')
app.commandLine.appendSwitch('disable-translate')
app.commandLine.appendSwitch('disable-metrics')
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,Translate,BackForwardCache,MediaRouter,OptimizationHints,DocumentPictureInPicture',
)

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 对外品牌名（窗口标题 / 关于面板 / 与应用名相关的文案统一走这里）。
 *
 * ⚠️ 注意与 electron-builder.yml 的 productName 保持同步；安装包名、开始菜单/桌面
 * 快捷方式、exe 名、以及「应用和功能」里的显示名都由 productName 决定，不读这个常量。
 *
 * ⚠️ 更不要为了改名去调 app.setName()：Electron 的 userData 路径派生自
 * app.getName()，改了它，%APPDATA%\ljanx\dsh-data 里的工作区/会话/模型授权
 * 会全部「消失」。package.json 的 name 与它必须保持为 ljanx。
 */
const APP_NAME = 'DeepSeek Agent'

/**
 * 品牌改名（jackdsh → ljanx）一次性数据迁移。
 *
 * package.json 的 `name` 决定 Electron 的 userData 路径，改名后若不做迁移，
 * 新的 %APPDATA%\ljanx 是空目录，用户会以为「工作区/会话/模型授权/插件
 * 全部消失」（数据其实还在旧的 %APPDATA%\jackdsh 里）。同盘 rename 是
 * 瞬时操作，944MB 也不影响启动。
 *
 * 迁移失败时（最典型的场景：旧版应用还开着，目录里的 lockfile 被占用）
 * 不硬来——退回继续使用旧目录，数据始终可用，下次启动再试。
 */
function migrateLegacyUserData() {
  try {
    const appData = app.getPath('appData')
    const legacy = join(appData, 'jackdsh')
    const current = join(appData, 'ljanx')
    if (existsSync(current) || !existsSync(legacy)) return
    try {
      renameSync(legacy, current)
      console.log(`[DeepSeek Agent] 已迁移数据目录: ${legacy} → ${current}`)
    } catch (error) {
      console.warn(
        `[DeepSeek Agent] 数据目录迁移失败（旧版本可能仍在运行），本次继续使用旧目录: ${error.message}`,
      )
      app.setPath('userData', legacy)
      app.setPath('sessionData', legacy)
    }
  } catch (error) {
    console.warn(`[DeepSeek Agent] 数据目录迁移检查失败: ${error.message}`)
  }
}

migrateLegacyUserData()

let mainWindow = null
let serverManager = null
let serverUrl = ''

const isPortable = process.argv.includes('--portable') || Boolean(process.env.DSH_PORTABLE)

/**
 * 跨平台首次启动数据存储引导与外接盘容错保护
 * 支持 Windows 引导避开 C 盘、macOS 引导使用专用存储（不占 iCloud / 支持外接移动硬盘）
 */
async function checkDataDirectory(userDataPath) {
  const configFile = join(userDataPath, 'dsh-home.json')
  const defaultPath = join(userDataPath, 'dsh-data')

  // 1. 若已有配置，检查目标路径是否可用（防止外接移动硬盘被拔掉导致崩溃）
  if (existsSync(configFile)) {
    let configuredPath = null
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'))
      const raw = typeof parsed?.dshHome === 'string' ? parsed.dshHome.trim() : ''
      configuredPath = raw || null
    } catch (error) {
      // 配置损坏不是致命错误：退回默认目录继续启动，只留一条日志
      console.warn(`[DeepSeek Agent] dsh-home.json 读取失败，回退默认数据目录: ${error.message}`)
    }

    if (configuredPath && !existsSync(configuredPath)) {
      const choice = await dialog.showMessageBox({
        type: 'warning',
        title: `${APP_NAME} - 数据存储目录未就绪`,
        message: '未检测到配置的数据存储路径',
        detail: `当前配置的存储路径不可访问：\n${configuredPath}\n\n如果你使用的是外接移动硬盘，请连接后再点击「重试」；或者你可以选择临时使用本机默认目录启动。`,
        buttons: ['重试', '临时使用默认目录', '退出应用'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      if (choice.response === 0) {
        return checkDataDirectory(userDataPath)
      } else if (choice.response === 2) {
        app.quit()
        return null
      }
      mkdirSync(defaultPath, { recursive: true })
      return defaultPath
    }

    if (configuredPath) return configuredPath
  }

  // 2. 默认静默就绪：零阻塞弹窗，直接确保默认数据目录就绪
  mkdirSync(defaultPath, { recursive: true })
  return defaultPath
}

// 单实例锁：防止多开或子进程误开导致 Dock 图标泛滥
const gotTheLock = app.requestSingleInstanceLock()

/**
 * 把已有窗口唤到前台。
 *
 * 启动期间 mainWindow 可能还不存在（内核尚未就绪），此时只记一个「待聚焦」标记，
 * 等窗口建好后补一次，避免用户双击之后毫无反馈。
 */
let windowFocusPending = false
function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    windowFocusPending = true
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

if (!gotTheLock) {
  // 抢锁失败 ⇒ 已经有实例在跑（它可能仍在启动中）。本进程必须就此结束。
  //
  // 绝对不能继续走 whenReady：那样本进程也会拉起一个内核，与已有实例抢同一个端口、
  // 抢同一批插件注册，把启动从几秒拖成几十秒（实测第 2 个实例的内核会另占 3181 端口）。
  // 而「用户以为没反应、于是再双击一次」恰好就会走到这里 —— 越点越慢的正反馈。
  app.quit()
} else {
  app.on('second-instance', () => focusMainWindow())
}

// 全局响应渲染层顶栏智能双击事件：安全切换窗口最大化与还原（macOS 原生 Zoom）
ipcMain.on('ljanx:window-toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  if (process.platform === 'darwin') {
    if (win.isFullScreen()) {
      win.setFullScreen(false)
    } else if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  } else {
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  }
})

// 纯净版（vanilla 分支）：主线在此有 ljanx:composer-diag 归因落盘（配合 preload 的
// 输入框点击兜底）。本分支不装兜底，因此这条通道整体不存在，需要时从 main 取回。

// ---------------------------------------------------------------------------
// 应用内「检查更新 / 下载更新 / 安装」
//
// 渲染层（左下角 sidebar.footer.action 的那个按钮）通过 preload 暴露的
// window.ljanxNative.update.* 调到这四个 handle。
// handler 只在主进程跑网络与落盘；渲染层拿不到 fs/网络之外的任何能力。
// ---------------------------------------------------------------------------
const updateLogger = (label, error) => {
  console.warn(`[updater] ${label}:`, error instanceof Error ? error.message : error)
}

/**
 * 读取当前随包安装的内核（@deepseek-ai/dsh）版本。
 * 开发态在仓库 node_modules，打包态在 <resources>/node_modules。
 * 读不到（异常安装）返回 null，面板显示「—」即可，不阻塞更新流程。
 */
function readBundledCoreVersion() {
  const candidates = [
    join(__dirname, '../../node_modules'),
    process.resourcesPath ? join(process.resourcesPath, 'node_modules') : '',
  ]
  for (const dir of candidates) {
    if (!dir) continue
    try {
      const pkg = JSON.parse(readFileSync(join(dir, '@deepseek-ai/dsh', 'package.json'), 'utf8'))
      if (pkg && pkg.version) return pkg.version
    } catch {}
  }
  return null
}

ipcMain.handle('ljanx:update-info', async () => ({
  ok: true,
  currentVersion: app.getVersion(),
  // 本机装的是哪条轨（正式版 / 纯净版）—— 面板顶部的轨道开关以此为准
  track: detectTrack(app.getVersion()),
  releasesPage: RELEASES_PAGE,
  downloaded: await listDownloaded(),
  platform: process.platform,
  arch: process.arch,
  // 检查更新面板的「当前应用详细信息」
  details: {
    appVersion: app.getVersion(),
    coreVersion: readBundledCoreVersion(),
    runtimeMode: process.env.DSH_PORTABLE ? 'portable' : 'installed',
    platform: `${process.platform}-${process.arch}`,
    electron: process.versions.electron || '',
    node: process.versions.node || '',
    chrome: process.versions.chrome || '',
    exePath: app.getPath('exe'),
    dataDir: app.getPath('userData'),
  },
}))

ipcMain.handle('ljanx:update-check', async (_event, payload) => {
  try {
    // 面板可以主动查另一条轨（用户点了「切换到纯净版 / 正式版轨道」）。
    // 缺省 = 本机那条轨 —— 绝不因为「另一条轨版本号更高」就把跨轨包推给用户。
    const wanted = payload && (payload.track === 'vanilla' || payload.track === 'stable')
      ? payload.track
      : undefined
    return await checkForUpdates({ currentVersion: app.getVersion(), track: wanted })
  } catch (error) {
    updateLogger('check failed', error)
    return { ok: false, error: `检查更新失败：${error instanceof Error ? error.message : String(error)}` }
  }
})

ipcMain.handle('ljanx:update-download', async (event, asset) => {
  try {
    const sender = event.sender
    const result = await downloadUpdate(asset, (progress) => {
      if (sender.isDestroyed()) return
      sender.send('ljanx:update-progress', progress)
    })
    return result
  } catch (error) {
    updateLogger('download failed', error)
    return { ok: false, error: `下载更新失败：${error instanceof Error ? error.message : String(error)}` }
  }
})

ipcMain.handle('ljanx:update-install', async (_event, filePath) => {
  try {
    return await installUpdate(filePath)
  } catch (error) {
    updateLogger('install failed', error)
    return { ok: false, error: `启动安装程序失败：${error instanceof Error ? error.message : String(error)}` }
  }
})

ipcMain.handle('ljanx:update-open-releases', async () => {
  try {
    await openReleasesPage()
    return { ok: true }
  } catch (error) {
    updateLogger('open releases failed', error)
    return { ok: false, error: '无法打开发布页。' }
  }
})

/**
 * 跨轨道（正式版 ↔ 纯净版）时的「先卸载旧版本」入口。
 *
 * 为什么跨轨不给「立即安装」：`1.4.3-vanilla.1` 按 semver 比 `1.4.3` 是降级，
 * 且两条轨共用同一个 appId 与产品名、从包上看不出彼此 —— 混着装只会让用户在
 * 「应用和功能」里看到一个说不清自己是谁的安装。所以这条路只把用户送到系统
 * 的卸载界面；卸载这一步由用户自己点，应用不代做不可逆动作。
 */
ipcMain.handle('ljanx:update-open-uninstall', async () => {
  try {
    return await openUninstallSettings()
  } catch (error) {
    updateLogger('open uninstall failed', error)
    return { ok: false, error: '无法打开系统的应用管理界面。' }
  }
})

// ---------------------------------------------------------------------------
// 内核（DSH）不做运行期更新：它随安装包整体发布，更新应用本体即更新内核。
// ---------------------------------------------------------------------------

/**
 * 菜单「检查更新」→ 打开渲染层那个面板。
 *
 * 用 electron 菜单唤起（而不是让菜单自己也弹一套 dialog）的好处是：
 * 菜单和面板共用同一份 UI 与状态，不会出现「菜单里查到的新版本、面板里看不到」。
 */
function openUpdatePanel() {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('ljanx:update-open-panel')
}

/**
 * 为 macOS 沉浸式标题栏（hiddenInset）注入精细化拖拽支持与交互防护：
 * 1. 顶部全局挂载弹性拖拽条：新会话空白页提供 38px 宽裕拖拽，有会话顶栏时收敛为 6px 边缘抓手；
 * 2. 侧栏顶栏让出交通灯宽度（约 78px），支持大面积拖拽；
 * 3. 会话顶栏：整行开启拖拽，特别将不可点击的当前会话标题（crumbCurrent）也赋予拖拽能力，大幅拓宽拖拽面积；
 * 4. 交互控件精准隔离：只将真正的交互控件（Tab、按钮、链接、输入框等）设为 no-drag；
 * 5. 模态弹窗深度隔离：弹窗存在时彻底静默所有背景拖拽，保证设置中心与「打开配置文件」等 100% 灵敏；
 * 6. 顶栏双击放大变小由 preload 的 dblclick 监听器安全接管，与拖拽区域彻底解绑。
 */
function setupMacWindowDrag(win) {
  if (process.platform !== 'darwin') return

  const titlebarCss = `
    /* 1. 顶部兜底拖拽条：新会话空白页时 38px 宽裕拖拽，有会话顶栏时收敛为 6px 边缘微缝 */
    #ljanx-titlebar-drag-strip {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 38px;
      z-index: 10;
      -webkit-app-region: drag;
    }
    :has(header:not([class*="headerHidden"])) #ljanx-titlebar-drag-strip,
    :has([class*="wSkVaW_header"]:not([class*="headerHidden"])) #ljanx-titlebar-drag-strip {
      height: 6px;
    }

    /* 2. 侧栏顶栏：允许拖拽，展开时避让交通灯宽度（78px） */
    [class*="logoRow"] {
      -webkit-app-region: drag !important;
    }
    [class*="logoRow"]:not([class*="collapsed"] *) {
      padding-left: 78px !important;
    }
    [class*="collapsed"] [class*="logoRow"] {
      margin-top: 28px !important;
    }

    /* 侧栏顶栏内交互元素禁止拖拽（保持折叠按钮等点击灵敏） */
    [class*="logoRow"] button,
    [class*="logoRow"] a,
    [class*="logoRow"] input,
    [class*="logoRow"] [role="button"] {
      -webkit-app-region: no-drag !important;
    }

    /* 3. 会话顶栏区域：允许整行与留白区域顺畅拖拽 */
    header,
    [class*="wSkVaW_header"] {
      -webkit-app-region: drag !important;
    }

    /* 会话标题文字：当前会话标题是不可点击的展示文本，明确赋予拖拽能力，随手抓取即可移动窗口 */
    [class*="crumbCurrent"],
    [class*="wSkVaW_crumbCurrent"],
    button[class*="crumb"][disabled] {
      -webkit-app-region: drag !important;
      cursor: default !important;
    }

    /* 4. 交互控件精准隔离（绝不误杀容器留白，确保点击 100% 灵敏） */
    button:not([class*="crumbCurrent"]):not([disabled][class*="crumb"]),
    a,
    input,
    select,
    textarea,
    [role="button"],
    [role="tab"],
    [role="menuitem"],
    [role="combobox"],
    [class*="iconButton"],
    [class*="close"],
    [class*="actions"],
    [class*="tab"]:not([class*="crumbCurrent"]),
    [class*="wSkVaW_tab"],
    [class*="headerActions"] button,
    [class*="headerUtilities"] button {
      -webkit-app-region: no-drag !important;
    }

    /* 5. 模态弹窗绝对防护（设置中心、打开配置文件、目录选择、导出等） */
    [role="dialog"],
    [role="dialog"] *,
    [aria-modal="true"],
    [aria-modal="true"] * {
      -webkit-app-region: no-drag !important;
    }

    /* 模态互斥：只要存在真实的弹窗，立刻隐藏顶部遮罩条并冻结背景拖拽 */
    body:has([role="dialog"]) #ljanx-titlebar-drag-strip,
    body:has([aria-modal="true"]) #ljanx-titlebar-drag-strip {
      display: none !important;
    }
    body:has([role="dialog"]) header,
    body:has([role="dialog"]) [class*="wSkVaW_header"],
    body:has([aria-modal="true"]) header,
    body:has([aria-modal="true"]) [class*="wSkVaW_header"] {
      -webkit-app-region: no-drag !important;
    }
  `

  // CSS 走「每文档一次」的注入（可省掉启动占位页那次无用的样式解析）；
  // 拖拽条 DOM 由脚本自带 presence 判断，重复执行是幂等的。
  injectCssOncePerDocument(win, titlebarCss)

  let dragStripDone = ''
  const injectDragStrip = async () => {
    if (!win || win.isDestroyed()) return
    let url = ''
    try {
      url = win.webContents.getURL()
    } catch {
      return
    }
    if (url.startsWith('data:') || url === dragStripDone) return
    dragStripDone = url
    try {
      await win.webContents.executeJavaScript(`
        (() => {
          if (!document.getElementById('ljanx-titlebar-drag-strip')) {
            const strip = document.createElement('div');
            strip.id = 'ljanx-titlebar-drag-strip';
            document.body.prepend(strip);
          }
        })()
      `)
    } catch (err) {
      console.warn('[DeepSeek Agent] Failed to inject mac titlebar drag strip:', err.message)
    }
  }
  win.webContents.on('dom-ready', injectDragStrip)
  win.webContents.on('did-finish-load', injectDragStrip)
}

/**
 * 把一段 CSS 注入到窗口，**每个文档只注入一次**。
 *
 * 为什么要这个包装：原先 dom-ready 与 did-finish-load 两个钩子各自 insertCSS 一次，
 * 而应用启动期间窗口会先后加载 **两个**文档（启动占位页 → 内核真实页），于是同一段
 * 规则在真实页面上被插了两遍。规则本身幂等（重复插入只是多一份同内容样式表），
 * 但每次注入都是一次主线程 + 渲染侧的样式解析，且会触发重新计算样式 —— 属于启动路径
 * 上不必要的开销。另外启动占位页是 data: URL，根本用不到这些规则，直接跳过。
 *
 * @param {Electron.BrowserWindow} win
 * @param {string} css
 */
function injectCssOncePerDocument(win, css) {
  let lastUrl = ''
  const inject = async () => {
    if (!win || win.isDestroyed()) return
    let url = ''
    try {
      url = win.webContents.getURL()
    } catch {
      return
    }
    // 启动占位页（data:）与「同一文档的第二次钩子」都不重复注入
    if (url.startsWith('data:')) return
    if (url === lastUrl) return
    lastUrl = url
    try {
      await win.webContents.insertCSS(css)
    } catch {
      // 窗口/文档在这期间被销毁，忽略
    }
  }
  win.webContents.on('dom-ready', inject)
  win.webContents.on('did-finish-load', inject)
}

/**
 * 设置中心侧边栏滚动样式兜底注入（所有平台通用）：
 * 当安装大量插件时，设置中心侧边栏高度超出 modal 面板高度，列表必须能够垂直滚动。
 */
function setupSettingsNavScroll(win) {
  const scrollCss = `
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
  injectCssOncePerDocument(win, scrollCss)
}

/**
 * 会话头部工具行的溢出兜底（所有平台通用）。
 *
 * 症状：打开右侧边栏（文件 / 任务管理）后，会话头部那一排按钮互相重叠，
 * 尾部按钮还被右侧面板盖掉一半。
 *
 * 实测根因（2026-09-19，在运行中的实例里量的，不是推断）：承载
 * `conversation.session.header.actions` 槽位的行容器（dsh-client-ui-conversation 的
 * `_heroWorkspaceRow` / `_workspaceRow` / `_titleRow`）是
 * `display:flex; flex-wrap:nowrap; overflow:visible`。插件往那一排里挂的按钮一多
 * （撤销 / 恢复 / 快照 / 对话撤回 …），内容就超出容器：造拥挤态实测容器 384px、
 * 内容 470px，最右按钮伸到 x=526，而中间列右边界是 442 ⇒ **横向溢出 84px**，
 * 直接伸进右侧面板的浮层下面（浮层盖在上面，看着就是"按钮重叠"）。
 *
 * 修法：让这一行换行而不是横向溢出。实测加 `flex-wrap:wrap` 后内容收回 384px、
 * 最右元素回到 x=362（列内还有 80px 余量），行高 28 → 56（两行），重叠消失。
 *
 * 为什么放宿主注入层而不是改插件或内核包：这一排的宽度由**装了几个插件**决定，
 * 补丁打在某个插件上只是碰巧；宿主兜底对任意插件组合都成立，也不动第三方源码。
 */
function setupConversationHeaderWrap(win) {
  const wrapCss = `
    [class*="_heroWorkspaceRow"],
    [class*="_workspaceRow"],
    [class*="_titleRow"] {
      flex-wrap: wrap !important;
      row-gap: 4px !important;
      min-width: 0 !important;
    }
    [class*="_heroWorkspaceRow"] > *,
    [class*="_workspaceRow"] > *,
    [class*="_titleRow"] > * {
      min-width: 0 !important;
    }
  `
  injectCssOncePerDocument(win, wrapCss)
}

function setupApplicationMenu(win) {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac
      ? [
          {
            // 用 APP_NAME 而非 app.name：app.name 取自 package.json 的 name（= ljanx，
            // 为保住 userData 路径不能改），直接用它 macOS 菜单栏会显示成小写内部名。
            label: APP_NAME,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据存储目录',
          click: () => {
            if (serverManager?.dshHome) shell.openPath(serverManager.dshHome)
          },
        },
        {
          label: '打开运行日志',
          click: () => {
            if (serverManager?.logFile) shell.openPath(serverManager.logFile)
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '检查更新',
      submenu: [
        {
          label: '检查更新…',
          click: () => openUpdatePanel(),
        },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开 GitHub 仓库',
          click: () => shell.openExternal('https://github.com/poying2018/deepseek-agent'),
        },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

/**
 * 启动占位页（data: URL，无额外文件）。
 *
 * 为什么必须有：装完首次启动是「冷启动」——杀软要实时扫描刚写盘的 400MB+ 产物，
 * 内核就绪实测可以到 30~40s。改造前这段时间**连窗口都没有**，用户看到的就是
 * 「双击完全没反应」，于是反复双击；而每次双击又会拉起一个内核抢端口，越点越慢。
 * 先把窗口亮出来，慢就从「没反应」变成「看得见地在加载」。
 */
function startupPageHtml(error) {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  const body = error
    ? `<div class="whale">🐳</div>
       <div class="name">${esc(APP_NAME)}</div>
       <div class="err">启动失败</div>
       <div class="hint">${esc(error)}</div>`
    : `<div class="whale">🐳</div>
       <div class="name">${esc(APP_NAME)}</div>
       <div class="ring"></div>
       <div class="hint">正在启动本地内核…<br>首次启动需要初始化配置，可能要多等一会儿</div>
       <div class="elapsed" id="t">已等待 0 秒</div>`

  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(APP_NAME)}</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px; background: #18181b; color: #e6e6ea; text-align: center;
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; }
  .whale { font-size: 42px; line-height: 1; animation: bob 2.4s ease-in-out infinite; }
  .name { font-size: 19px; font-weight: 600; letter-spacing: .3px; }
  .ring { width: 30px; height: 30px; border-radius: 50%;
    border: 3px solid rgba(255,255,255,.14); border-top-color: #4D6BFE;
    animation: spin .9s linear infinite; }
  .hint { color: #9b9ba6; font-size: 12.5px; max-width: 440px; }
  .elapsed { color: #6f6f7c; font-size: 12px; font-variant-numeric: tabular-nums; }
  .err { color: #ff8a8a; font-size: 15px; font-weight: 600; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
</style></head><body>
  ${body}
  <script>
    var t0 = Date.now(), el = document.getElementById('t');
    if (el) setInterval(function () {
      el.textContent = '已等待 ' + Math.round((Date.now() - t0) / 1000) + ' 秒';
    }, 1000);
  </script>
</body></html>`)}`
}

async function createWindow() {
  // ── ① 先建窗口并立刻显示加载态 ─────────────────────────────────────────
  // 内核启动放到窗口之后（见下方 ②）。这样冷启动的几十秒里用户看到的是一个
  // 在动的加载页，而不是一片虚无。
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#18181b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 12 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  setupMacWindowDrag(mainWindow)
  setupSettingsNavScroll(mainWindow)
  setupConversationHeaderWrap(mainWindow)
  setupApplicationMenu(mainWindow)

  // 网页底座自带 <title>DeepSeek Harness</title>，不拦就会顶掉窗口标题，
  // 任务栏/窗口标题里永远看不到发行版品牌名。这里拦下来做**定向改写**：
  //   · 把底座名 DeepSeek Harness 换成品牌名；
  //   · 保留 dsh-app-badge 插件加在前面的未读计数前缀，如 "(3) DeepSeek Agent"。
  // 不做整串覆盖，是为了不丢掉其他动态标题（会话名等）。
  mainWindow.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    const renamed = String(title || '').replace(/DeepSeek\s+Harness/g, APP_NAME)
    mainWindow?.setTitle(renamed.trim() || APP_NAME)
  })

  // 外部链接默认用系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // 应用窗口本身也绝不导航到外部站点（那条路绕不过 windowOpenHandler）：
  // 有些插件在「新窗口被拒」后会退化成 `window.location.href = 登录页`，
  // 把主窗口整页变成第三方登录页——用户看到的就是「应用里开了个浏览器」。
  // 这里统一改成交给系统浏览器，同源（内核页面/前端路由）照常放行。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!/^https?:/i.test(url)) return
    try {
      const target = new URL(url)
      const appOrigin = serverUrl ? new URL(serverUrl).origin : ''
      if (target.origin === appOrigin) return
      event.preventDefault()
      shell.openExternal(url)
    } catch {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    // 注意：启动占位页是超长的 data: URL，别整串打出来
    const u = mainWindow?.webContents.getURL() || ''
    console.log('[Electron Window] did-finish-load:', u.startsWith('data:') ? '(启动占位页)' : u)
  })

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[Electron Window] did-fail-load:', errorCode, errorDescription, validatedURL)
  })

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // 只镜像 warning(1)/error(2)，过滤 28 个插件启动期的 info 级刷屏，
    // 降低主进程 I/O 与启动期卡顿；info 级内容仍可在渲染进程内 DevTools 看到。
    if (level >= 1) console.log('[Renderer Console]', message)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(startupPageHtml())

  // 启动期间若有第二个实例来敲门（用户以为没反应又点了一次），
  // 窗口一建好就补一次「显示 + 聚焦」，让那次双击不白点。
  if (windowFocusPending) {
    windowFocusPending = false
    focusMainWindow()
  }

  // ── ② 再启动内核 ────────────────────────────────────────────────────────
  // 冷启动（装完首次，杀软扫描新写盘产物）实测可达 30~40s；此时窗口已经亮着，
  // 用户能看到「已等待 N 秒」在走，而不是面对一片虚无反复双击。
  const freePort = await findFreePort(3180)

  serverManager = new ServerManager({
    port: freePort,
    isPortable,
    appDataPath: app.getPath('userData'),
    runtimePath: app.isPackaged
      ? join(process.resourcesPath, 'runtime')
      : join(__dirname, '../../bundle-runtime'),
  })

  serverUrl = await serverManager.start()

  // ── ③ 内核就绪，切到真实地址 ────────────────────────────────────────────
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadURL(serverUrl)
}

app.whenReady().then(async () => {
  // 抢锁失败的实例到此为止：不许建窗口、更不许启动内核。
  // 这条闸不能省 —— 实测过「抢锁失败但 whenReady 仍然跑完」的情形。
  if (!gotTheLock) return

  try {
    // 底座版本必须读出来，不能再写死：这里曾经硬编码 v0.1.2-rc.1，而内核早已升到
    // 0.1.5-rc.2 —— 关于面板说出的版本号是错的，用户排查问题时会被带去错的轨道。
    // 查找顺序与 server-manager 里定位内核 bin.js 的一致：安装版在 <resources>/node_modules
    // （随 asar），开发态在仓库 node_modules。读不到就整条省掉，宁可少一行也不报假版本。
    const kernelPkgCandidates = [
      process.resourcesPath ? join(process.resourcesPath, 'node_modules') : '',
      join(__dirname, '../../node_modules'),
    ].filter(Boolean)
    let kernelVersion = ''
    for (const root of kernelPkgCandidates) {
      const pkgJson = join(root, '@deepseek-ai', 'dsh', 'package.json')
      if (!existsSync(pkgJson)) continue
      try {
        const v = JSON.parse(readFileSync(pkgJson, 'utf8')).version
        if (typeof v === 'string' && v) { kernelVersion = v; break }
      } catch {}
    }
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: `v${app.getVersion()}`,
      ...(kernelVersion ? { version: `DeepSeek Harness 底座 v${kernelVersion}` } : {}),
      copyright: 'LJANX · 基于 DeepSeek Harness 官方框架构建',
    })
    await checkDataDirectory(app.getPath('userData'))
    await createWindow()
  } catch (err) {
    console.error('[DeepSeek Agent Fatal]', err)
    const logPath = serverManager?.logFile || ''
    const dshHome = serverManager?.dshHome || ''

    // 窗口已经亮着（占位页），把失败原因就地写在窗口里，
    // 免得用户面对一个永远转下去的圈，误以为程序卡死。
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(startupPageHtml(err?.message || String(err)))
      }
    } catch {}

    const choice = await dialog.showMessageBox({
      type: 'error',
      title: `${APP_NAME} 启动遇到异常`,
      message: '后台服务未能正常就绪',
      detail: `${err.message}\n\n可能存在端口占用、网络代理或旧版配置冲突。建议点击下方按钮查看运行日志排错。`,
      buttons: ['查看运行日志', '打开数据目录自检', '退出应用'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })

    if (choice.response === 0) {
      if (logPath && existsSync(logPath)) {
        await shell.openPath(logPath)
      } else if (dshHome && existsSync(dshHome)) {
        await shell.openPath(dshHome)
      }
    } else if (choice.response === 1) {
      if (dshHome && existsSync(dshHome)) {
        await shell.openPath(dshHome)
      }
    }
    app.quit()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  if (serverManager) {
    serverManager.stop()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
