/**
 * 桌面端自更新：查询 GitHub Release → 下载安装包 → 交给系统安装程序。
 *
 * 设计取舍：
 * - **不用 electron-updater**。它要求 Release 里带 `latest.yml`、且对「非签名构建」
 *   的校验路径较绕；本发行版的 Release 资产就是普通安装包（NSIS exe / dmg），
 *   直接用 GitHub API + 自己下载，链路更短、更容易排查。
 * - 查询走 **GitHub REST API**（`/releases/latest`，一次请求）。未认证配额 60 次/小时/IP，
 *   对一个「点一次查一次」的按钮完全够用；被限流时返回明确文案而不是静默失败。
 * - 只认**正式版**：带 `-rc` / `-beta` / `-alpha` 的 tag 一律跳过，不会把预发布推给用户。
 * - 安装包下载到 `<userData>/updates/`；同名同大小已存在则复用，不重复拉取。
 * - 下载完不自动安装，由用户在面板上点「立即安装」——避免偷偷重启应用。
 */

import { app, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 发布地址（同时用于构造 API 与「打开发布页」） */
export const RELEASE_OWNER = 'poying2018'
export const RELEASE_REPO = 'deepseek-agent'
export const RELEASES_PAGE = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases`

const API_LATEST = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`
/** API 被限流时的兜底源：网站页面，无 60 次/小时/IP 的配额限制 */
const ATOM_FEED = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases.atom`
const UPDATES_DIR = 'updates'
const USER_AGENT = 'DeepSeek-Agent-Desktop-Updater'

// ---------------------------------------------------------------- 版本号比较

/**
 * 解析 semver，返回 { parts: [major,minor,patch], prerelease }。
 * 解析失败返回 null（调用方一律当作「无法比较」，不去猜）。
 */
export function parseSemver(input) {
  if (typeof input !== 'string') return null
  const value = input.trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value)
  if (!match) return null
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || null,
  }
}

/** a > b 返回正数，a < b 返回负数，相等返回 0；任一侧无法解析返回 null。 */
export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i]
  }
  // 同版本号时：正式版 > 预发布版
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

export function isStableVersion(input) {
  const parsed = parseSemver(input)
  return parsed !== null && parsed.prerelease === null
}

// ---------------------------------------------------------------- 安装包资产

/**
 * 当前平台该下哪个安装包。
 *
 * 资产名由 `electron-builder.yml` 的 `artifactName` 决定：
 *   win   → DeepSeek-Agent-<version>-Windows-Setup.exe
 *   mac   → DeepSeek-Agent-<version>-Mac-arm64.dmg
 *
 * ⚠️ 两道校验缺一不可，**绝不能退化成「只按扩展名匹配」**：
 *   1. 产品前缀 `deepseek-agent-`——否则别的产品遗留的同扩展名资产会被当成自己的更新包。
 *      本仓库历史上真的踩过：更新逻辑只比对扩展名，于是旧产品发布的
 *      `JackDSH-9.14.23-Mac-arm64.dmg` 被当作新版本推给了用户。
 *   2. 平台/架构后缀——否则 x64 机器会去下 arm64 的包。
 */
const PRODUCT_PREFIX = 'deepseek-agent-'

function matchesCurrentPlatform(name, platform = process.platform, arch = process.arch) {
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.blockmap') || lower.endsWith('.yml') || lower.endsWith('.json')) return false
  if (!lower.startsWith(PRODUCT_PREFIX)) return false
  if (platform === 'win32') {
    return lower.endsWith('-windows-setup.exe')
  }
  if (platform === 'darwin') {
    const wanted = arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
    return lower.endsWith(`-${wanted}.dmg`)
  }
  return lower.endsWith('.appimage') || lower.endsWith('.deb')
}

export function pickInstallerAsset(assets, platform = process.platform, arch = process.arch) {
  if (!Array.isArray(assets)) return null
  const hit = assets.find((asset) => asset && typeof asset.name === 'string'
    && matchesCurrentPlatform(asset.name, platform, arch))
  if (!hit) return null
  return {
    name: hit.name,
    url: hit.browser_download_url || hit.url || '',
    size: Number(hit.size) || 0,
  }
}

// ---------------------------------------------------------------- 检查更新

/** 把 HTTP 状态码翻成用户能看懂的话。 */
function describeHttpFailure(status) {
  if (status === 404) return '还没有已发布的版本。'
  if (status === 403 || status === 429) return 'GitHub 接口请求过于频繁，请稍后再试。'
  if (status >= 500) return 'GitHub 暂时不可用，请稍后再试。'
  return `请求发布信息失败（HTTP ${status}）。`
}

/**
 * 按 `electron-builder.yml` 的 artifactName 规则拼出安装包文件名。
 *
 * 有了它，即使拿不到 Release 的资产列表（见下面的 atom 兜底），也能确定下载地址——
 * 因为资产名是**确定性**的，不含随机成分。
 */
export function expectedAssetName(version, platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return `DeepSeek-Agent-${version}-Windows-Setup.exe`
  if (platform === 'darwin') return `DeepSeek-Agent-${version}-Mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
  return ''
}

function assetFromVersion(version, platform = process.platform, arch = process.arch) {
  const name = expectedAssetName(version, platform, arch)
  if (!name) return null
  return {
    name,
    url: `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/v${version}/${name}`,
    size: 0, // atom 拿不到体积；下载时以响应头的 content-length 为准
  }
}

/** 走 GitHub REST API：能同时拿到更新说明与精确的资产列表。 */
async function checkViaApi(currentVersion) {
  let response
  try {
    response = await fetch(API_LATEST, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
      },
    })
  } catch (error) {
    return { fallback: true, reason: `无法连接 GitHub：${error instanceof Error ? error.message : String(error)}` }
  }

  if (!response.ok) {
    if (response.status === 404) return { ok: true, status: 'no-release', currentVersion, source: 'api' }
    return { fallback: true, reason: describeHttpFailure(response.status) }
  }

  let release
  try {
    release = await response.json()
  } catch {
    return { fallback: true, reason: '发布信息解析失败。' }
  }

  const tag = typeof release?.tag_name === 'string' ? release.tag_name : ''
  const latestVersion = tag.replace(/^v/i, '')
  if (!latestVersion || !isStableVersion(latestVersion)) {
    // 只有预发布版时视为「已是最新」——不把 rc/beta 推给普通用户
    return { ok: true, status: 'latest', currentVersion, latestVersion: latestVersion || null, source: 'api' }
  }

  const verdict = compareSemver(latestVersion, currentVersion)
  const base = {
    ok: true,
    currentVersion,
    latestVersion,
    releaseUrl: typeof release.html_url === 'string' ? release.html_url : RELEASES_PAGE,
    notes: typeof release.body === 'string' ? release.body : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    asset: pickInstallerAsset(release.assets),
    source: 'api',
  }
  // verdict === null 表示本机版本号不合 semver（自编译等），此时不谎报「有新版本」
  if (verdict === null) return { ...base, status: 'latest', asset: null }
  return { ...base, status: verdict > 0 ? 'available' : 'latest' }
}

/**
 * 从 releases.atom 的条目正文里提取更新说明。
 *
 * 此前误判 atom「拿不到更新说明」——其实每个 <entry> 的 <content type="html">
 * 里就带着 Release 正文。转义 HTML → 去标签 → 压缩空行，得到纯文本说明；
 * 解析失败返回空串（面板再走「未填写说明」的降级文案）。
 */
function notesFromAtomEntry(xml, version) {
  try {
    const entries = xml.split('<entry>').slice(1)
    const entry = entries.find((chunk) => {
      const tag = chunk.match(/\/releases\/tag\/([^"'\s<>]+)/)
      if (!tag) return false
      try {
        return decodeURIComponent(tag[1]).replace(/^v/i, '') === version
      } catch { return false }
    })
    if (!entry) return ''
    const raw = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || ''
    const decoded = raw
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
    return decoded
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|pre)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return ''
  }
}

/**
 * 兜底：走 releases.atom。
 *
 * 为什么要它：api.github.com 未认证配额只有 60 次/小时/**IP**。校园网、公司网这类
 * NAT 共享出口很容易被别的使用者耗尽（本机实测就已被限流），届时 API 直接 403。
 * atom feed 属于网站页面、没有这个限制；资产列表拿不到，下载地址用
 * `assetFromVersion` 按确定性规则拼出来；更新说明从条目正文提取（见上）。
 */
async function checkViaAtom(currentVersion) {
  let xml
  try {
    const response = await fetch(ATOM_FEED, { headers: { 'user-agent': USER_AGENT } })
    if (!response.ok) return null
    xml = await response.text()
  } catch {
    return null
  }

  // 从 `<link ... /releases/tag/<tag>/>` 取标签，**不要**去解析 <title>：
  // 真实 Release 标题常带前后缀（如「JackDSH v9.12.16 — 极简双版本开箱安装包」），
  // 按整条标题匹配 semver 会大量漏掉，于是误判成「已是最新」。
  const versions = [...xml.matchAll(/\/releases\/tag\/([^"'\s<>]+)/g)]
    .map((match) => decodeURIComponent(match[1]).replace(/^v/i, ''))
    .filter(isStableVersion)
    .sort((a, b) => compareSemver(b, a))

  const latestVersion = versions[0]
  if (!latestVersion) {
    // feed 可达但没有任何正式版 ⇒ 仓库还没发过版。这是明确结论，
    // 不该退回「接口限流」那种误导性报错。
    return { ok: true, status: 'no-release', currentVersion, source: 'atom' }
  }

  const verdict = compareSemver(latestVersion, currentVersion)
  const hasNewer = verdict !== null && verdict > 0
  return {
    ok: true,
    status: hasNewer ? 'available' : 'latest',
    currentVersion,
    latestVersion,
    releaseUrl: `${RELEASES_PAGE}/tag/v${latestVersion}`,
    notes: notesFromAtomEntry(xml, latestVersion),
    publishedAt: '',
    asset: hasNewer ? assetFromVersion(latestVersion) : null,
    source: 'atom',
  }
}

/**
 * 查询是否有新版本。
 *
 * 先走 API（有更新说明），失败则退回 atom feed。
 *
 * @returns {Promise<{ok:boolean, status?:string, error?:string, currentVersion?:string,
 *                    latestVersion?:string, releaseUrl?:string, notes?:string,
 *                    publishedAt?:string, asset?:{name,url,size}|null, source?:string}>}
 *   status: `available` 有新版 / `latest` 已是最新 / `no-release` 尚未发版
 */
export async function checkForUpdates(options = {}) {
  const currentVersion = options.currentVersion || app.getVersion()

  const viaApi = await checkViaApi(currentVersion)
  if (viaApi && viaApi.fallback !== true) return viaApi

  const viaAtom = await checkViaAtom(currentVersion)
  if (viaAtom) return viaAtom

  return { ok: false, error: (viaApi && viaApi.reason) || '检查更新失败，请稍后再试。' }
}

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
