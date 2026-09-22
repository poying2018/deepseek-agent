/**
 * 桌面端自更新的「IO 半边」：下载安装包 → 交给系统安装程序。
 *
 * ⚠️ 版本判定与 GitHub 查询逻辑**不在这里**，在 ./update-tracks.js ——
 * 那段是纯函数、要能在普通 node 下用假 payload 断言（`pnpm check:updater`），
 * 而本文件 import electron，测试进程 import 不动它。这里再实现一套 semver
 * 就是给未来留下第二份会各自漂移的真相。
 *
 * 设计取舍：
 * - **不用 electron-updater**。它要求 Release 里带 `latest.yml`、且对「非签名构建」
 *   的校验路径较绕；本发行版的 Release 资产就是普通安装包（NSIS exe / dmg），
 *   直接用 GitHub API + 自己下载，链路更短、更容易排查。
 * - 安装包下载到 `<userData>/updates/`；同名同大小已存在则复用，不重复拉取。
 * - 下载完不自动安装，由用户在面板上点「立即安装」——避免偷偷重启应用。
 * - 跨轨道（正式版 ↔ 纯净版）**不走**这条路：那条路上没有 asset，只有
 *   「先卸载旧版本」的引导，见 update-tracks.js 的不变量 3 与 openUninstallSettings。
 */

import { app, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { USER_AGENT, RELEASES_PAGE } from './update-tracks.js'

// 面板与主进程都从这里取常量/判定，实际定义只有一份（./update-tracks.js）
export { RELEASES_PAGE }
export {
  RELEASE_OWNER,
  RELEASE_REPO,
  API_LATEST,
  API_RELEASES,
  ATOM_FEED,
  TRACK_STABLE,
  TRACK_VANILLA,
  checkForUpdates,
  detectTrack,
  releaseTrack,
  tagTrack,
  compareSemver,
  parseSemver,
  isStableVersion,
  expectedAssetName,
  pickInstallerAsset,
} from './update-tracks.js'

const UPDATES_DIR = 'updates'

// ---------------------------------------------------------------- 下载

function updatesDir() {
  const dir = join(app.getPath('userData'), UPDATES_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 已下载过且大小一致的文件直接复用，避免重复拉几百 MB。 */
function findExisting(dir, name, expectedSize) {
  const target = join(dir, name)
  if (!existsSync(target)) return null
  try {
    const actual = statSync(target).size
    if (expectedSize > 0 && actual !== expectedSize) {
      unlinkSync(target) // 上次下到一半的残file，删掉重来
      return null
    }
    return target
  } catch {
    return null
  }
}

/**
 * 下载安装包。
 *
 * @param {{name:string,url:string,size:number}} asset
 * @param {(progress:{received:number,total:number,percent:number})=>void} [onProgress]
 * @returns {Promise<{ok:boolean, filePath?:string, reused?:boolean, error?:string}>}
 */
export async function downloadUpdate(asset, onProgress) {
  if (!asset || typeof asset.url !== 'string' || asset.url === '') {
    return { ok: false, error: '当前平台没有可用的安装包资产。' }
  }
  const name = String(asset.name || 'update-package').replace(/[/\\]/g, '_')
  const dir = updatesDir()

  const existing = findExisting(dir, name, Number(asset.size) || 0)
  if (existing) return { ok: true, filePath: existing, reused: true }

  const target = join(dir, name)
  const temp = `${target}.part`

  let response
  try {
    response = await fetch(asset.url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
    })
  } catch (error) {
    return { ok: false, error: `下载失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok || !response.body) {
    return { ok: false, error: `下载失败（HTTP ${response.status}）。` }
  }

  const total = Number(response.headers.get('content-length')) || Number(asset.size) || 0
  let received = 0
  let lastPercent = -1

  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    if (typeof onProgress !== 'function') return
    const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0
    // 按整数百分比节流，避免每秒几十次 IPC
    if (percent !== lastPercent) {
      lastPercent = percent
      onProgress({ received, total, percent })
    }
  })

  try {
    await pipeline(source, createWriteStream(temp))
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    return { ok: false, error: `写入文件失败：${error instanceof Error ? error.message : String(error)}` }
  }

  if (total > 0 && received !== total) {
    try { unlinkSync(temp) } catch {}
    return { ok: false, error: `下载不完整（${received}/${total} 字节），已丢弃。` }
  }

  try {
    const { renameSync } = await import('node:fs')
    renameSync(temp, target)
  } catch (error) {
    return { ok: false, error: `保存安装包失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof onProgress === 'function') onProgress({ received, total: total || received, percent: 100 })
  return { ok: true, filePath: target, reused: false }
}

/** 列出已下载但未安装的安装包（供面板显示「已下载」状态）。 */
export async function listDownloaded() {
  try {
    const dir = updatesDir()
    const names = await readdir(dir)
    return names.filter((n) => /\.(exe|dmg|msi|AppImage|deb)$/i.test(n)).map((n) => join(dir, n))
  } catch {
    return []
  }
}

/**
 * 启动安装程序。
 *
 * 注意：安装包必须由系统外壳来跑（NSIS 要弹自己的向导），所以这里
 * `shell.openPath` 而**不是** spawn——沙箱化后 spawn 安装器容易被拦。
 * 调用方负责在合适时机退出应用（Windows 上运行中的 exe 无法被覆盖）。
 */
export async function installUpdate(filePath) {
  if (typeof filePath !== 'string' || !existsSync(filePath)) {
    return { ok: false, error: '安装包不存在，请重新下载。' }
  }
  const error = await shell.openPath(filePath)
  if (error) return { ok: false, error: `无法启动安装程序：${error}` }
  return { ok: true }
}

/** 在浏览器里打开发布页。 */
export async function openReleasesPage() {
  await shell.openExternal(RELEASES_PAGE)
}

/**
 * 打开系统的「已安装应用」入口，让用户去卸载当前版本。
 *
 * 只给跨轨道（正式版 ↔ 纯净版）那条引导用：那是换轨不是升级，必须先把旧版本
 * 卸掉再装另一条轨的包（详见 update-tracks.js 顶部不变量 3）。这里刻意**不去
 * 调卸载器**：卸载是不可逆动作，交给用户在系统界面里自己点。
 *
 * @returns {Promise<{ok:boolean, opened?:string, error?:string}>}
 */
export async function openUninstallSettings() {
  if (process.platform === 'win32') {
    const target = 'ms-settings:appsfeatures'
    try {
      const error = await shell.openExternal(target)
      if (!error) return { ok: true, opened: target }
      return { ok: false, error: `无法打开「应用和功能」：${error}` }
    } catch (error) {
      return { ok: false, error: `无法打开「应用和功能」：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (process.platform === 'darwin') {
    // macOS 没有集中的卸载面板，直接把「应用程序」文件夹摊开让用户拖到废纸篓
    const error = await shell.openPath('/Applications')
    if (!error) return { ok: true, opened: '/Applications' }
    return { ok: false, error: `无法打开「应用程序」文件夹：${error}` }
  }
  return { ok: false, error: '当前系统没有可自动打开的卸载入口，请按你常用的方式先卸载现有版本。' }
}
