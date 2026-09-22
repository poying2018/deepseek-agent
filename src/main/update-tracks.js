/**
 * 更新轨道判定与「有没有新版本」的纯逻辑。
 *
 * 这个文件**刻意不 import electron**：轨道判定是整套更新逻辑里最容易串台的一段，
 * 必须能在普通 `node` 下用假 payload 断言（见 scripts/check-updater-tracks.mjs，
 * `pnpm check:updater`）。所有需要 electron 能力的部分（userData 落盘、shell 打开
 * 安装器）留在 updater.js 里。
 *
 * ── 为什么要有"轨道"这个概念 ─────────────────────────────────────────────
 * 本发行版有两条交付轨，共用同一个 appId（com.ljanx.agent）、同一个产品名
 * （DeepSeek Agent）、同一套资产命名规则（DeepSeek-Agent-<version>-Windows-Setup.exe）：
 *
 *   · 正式轨（main 分支）    tag `v1.4.3`              GitHub 上 release
 *   · 纯净轨（vanilla 分支）  tag `v1.4.3-vanilla.1`    GitHub 上 prerelease
 *
 * 两者从包名和安装位置上**完全看不出区别**，装错轨道的后果是纯净版用户被塞进
 * 260MB 的全插件包（或反过来）。v1.4.3 及之前，更新器只查 `/releases/latest`
 * 并在 atom 兜底里按 `isStableVersion` 过滤 —— 纯净版用户点「检查更新」必然拿到
 * 正式版的包，这就是本次修掉的串台。
 *
 * ── 三条不变量 ───────────────────────────────────────────────────────────
 *   1. 装在哪条轨由**自身版本号**决定（`-vanilla.N` 后缀），解析不出来时保守归
 *      正式轨：宁可漏提示纯净版更新，也不把全插件包误推给纯净版用户。
 *   2. 查询按轨道分：纯净轨**必须**查 `/releases` 列表 —— GitHub 的
 *      `/releases/latest` 端点结构上永不返回 prerelease，拿它查纯净轨永远查不到。
 *   3. 跨轨不是升级：`1.4.3-vanilla.1` 按 semver 比 `1.4.3` 是**降级**，所以跨轨
 *      一律不看版本号大小，直接报 `cross-track` 且**不携带可下载资产**，由面板
 *      引导「先卸载当前版本再装另一条轨」。
 */

export const RELEASE_OWNER = 'poying2018'
export const RELEASE_REPO = 'deepseek-agent'
export const RELEASES_PAGE = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases`

const API_BASE = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}`
/** 正式轨：GitHub 保证只返回最新的非 prerelease、非 draft */
export const API_LATEST = `${API_BASE}/releases/latest`
/** 纯净轨：唯一能拿到 prerelease 的接口 */
export const API_RELEASES = `${API_BASE}/releases?per_page=30`
/** API 被限流时的兜底源：网站页面，无 60 次/小时/IP 的配额限制 */
export const ATOM_FEED = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases.atom`

export const USER_AGENT = 'DeepSeek-Agent-Desktop-Updater'

export const TRACK_STABLE = 'stable'
export const TRACK_VANILLA = 'vanilla'

/** 纯净版 tag 的 prerelease 首段标识（`1.4.3-vanilla.1` → `vanilla`） */
const VANILLA_MARKER = 'vanilla'

// ---------------------------------------------------------------- semver

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

function stripV(input) {
  return typeof input === 'string' ? input.trim().replace(/^v/i, '') : ''
}

/** prerelease 的第一段标识符（`1.4.3-vanilla.1` → `vanilla`；无 prerelease → null） */
function markerOf(parsed) {
  if (!parsed || !parsed.prerelease) return null
  return parsed.prerelease.split('.')[0]
}

// ---------------------------------------------------------------- 轨道判定

/**
 * 本机装的是哪条轨。参数是 app.getVersion()。
 * 解析不出来 / 不是 vanilla 后缀 —— 一律正式轨（不变量 1）。
 */
export function detectTrack(version) {
  return markerOf(parseSemver(version)) === VANILLA_MARKER ? TRACK_VANILLA : TRACK_STABLE
}

/**
 * 一个 tag 属于哪条轨 —— **只看 tag 本身**，用于 atom 兜底（feed 里没有
 * prerelease 标志可读）。不合 semver、或 prerelease 段不是 vanilla 的（rc/beta）
 * 返回 null：那种包两条轨都不该推给普通用户。
 */
export function tagTrack(tag) {
  const parsed = parseSemver(stripV(tag))
  if (!parsed) return null
  if (parsed.prerelease === null) return TRACK_STABLE
  return markerOf(parsed) === VANILLA_MARKER ? TRACK_VANILLA : null
}

/**
 * 一个 GitHub Release 属于哪条轨。`prerelease` 标志在这里只用来**否掉**一种情况：
 * tag 长得像正式版却被标成 prerelease（手工发版勾错框），这种不认，免得半成品
 * 顺着正式轨推给用户。反过来 tag 里明确写了 -vanilla 就认纯净轨，标志漏勾不影响。
 */
export function releaseTrack(tag, prerelease = false) {
  const track = tagTrack(tag)
  if (track === TRACK_STABLE && prerelease === true) return null
  return track
}

// ---------------------------------------------------------------- 安装包资产

/**
 * 当前平台该下哪个安装包。
 *
 * 资产名由 `electron-builder.yml` 的 `artifactName` 决定：
 *   win   → DeepSeek-Agent-<version>-Windows-Setup.exe
 *   mac   → DeepSeek-Agent-<version>-Mac-arm64.dmg
 * `<version>` 对纯净轨就是 `1.4.3-vanilla.1` 这种带 prerelease 段的字面量。
 *
 * ⚠️ 两道校验缺一不可，**绝不能退化成「只按扩展名匹配」**：
 *   1. 产品前缀 `deepseek-agent-`——否则别的产品遗留的同扩展名资产会被当成自己的更新包。
 *      本仓库历史上真的踩过：更新逻辑只比对扩展名，于是旧产品发布的
 *      `LJANX-9.14.23-Mac-arm64.dmg` 被当作新版本推给了用户。
 *   2. 平台/架构后缀——否则 x64 机器会去下 arm64 的包。
 */
const PRODUCT_PREFIX = 'deepseek-agent-'

export function matchesCurrentPlatform(name, platform = process.platform, arch = process.arch) {
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

/**
 * 按 `electron-builder.yml` 的 artifactName 规则拼出安装包文件名。
 *
 * 有了它，即使拿不到 Release 的资产列表（atom 兜底），也能确定下载地址 ——
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

// ---------------------------------------------------------------- 挑选与判定

/** 从 `/releases` 列表里挑出属于指定轨道的最新一个 release；没有则 null。 */
export function pickReleaseForTrack(releases, track) {
  if (!Array.isArray(releases)) return null
  const candidates = releases
    .filter((r) => r && r.draft !== true)
    .map((r) => ({ release: r, track: releaseTrack(r.tag_name, r.prerelease === true) }))
    .filter((r) => r.track === track)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const verdict = compareSemver(stripV(b.release.tag_name), stripV(a.release.tag_name))
    return verdict === null ? 0 : verdict
  })
  return candidates[0].release
}

/** 从 atom 的 tag 列表里挑出指定轨道的最新版本号（没有则 null）。 */
export function pickVersionForTrack(tags, track) {
  if (!Array.isArray(tags)) return null
  const versions = tags.map(stripV).filter((v) => tagTrack(v) === track)
  if (versions.length === 0) return null
  versions.sort((a, b) => {
    const verdict = compareSemver(b, a)
    return verdict === null ? 0 : verdict
  })
  return versions[0]
}

/** 把 HTTP 状态码翻成用户能看懂的话。 */
function describeHttpFailure(status) {
  if (status === 404) return '还没有已发布的版本。'
  if (status === 403 || status === 429) return 'GitHub 接口请求过于频繁，请稍后再试。'
  if (status >= 500) return 'GitHub 暂时不可用，请稍后再试。'
  return `请求发布信息失败（HTTP ${status}）。`
}

function releaseFields(release, platform, arch) {
  const version = stripV(release.tag_name)
  return {
    latestVersion: version,
    releaseUrl: typeof release.html_url === 'string' ? release.html_url : `${RELEASES_PAGE}/tag/v${version}`,
    notes: typeof release.body === 'string' ? release.body : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    asset: pickInstallerAsset(release.assets, platform, arch),
  }
}

// ---------------------------------------------------------------- atom 正文
// atom 的每个 <entry> 的 <content type="html"> 里就带着 Release 正文（此前误判
// 「atom 拿不到更新说明」）。转义 HTML → 去标签 → 压缩空行；解析失败返回空串，
// 面板再走「未填写说明」的降级文案。

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

// ---------------------------------------------------------------- 各轨道的取源

/**
 * 正式轨：`/releases/latest` 一次请求拿到版本、说明与资产列表。
 * 返回 { fallback:true, reason } 表示要退 atom；返回 null 表示这条路上拿不到
 * 正式轨的 release（例如有人把唯一正式版误标成 prerelease），改走列表接口。
 */
async function stableViaApi({ fetchImpl, platform, arch }) {
  let response
  try {
    response = await fetchImpl(API_LATEST, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    })
  } catch (error) {
    return { fallback: true, reason: `无法连接 GitHub：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) {
    if (response.status === 404) return { ok: true, status: 'no-release', source: 'api' }
    return { fallback: true, reason: describeHttpFailure(response.status) }
  }
  let release
  try {
    release = await response.json()
  } catch {
    return { fallback: true, reason: '发布信息解析失败。' }
  }
  if (!release || typeof release.tag_name !== 'string') return { ok: true, status: 'no-release', source: 'api' }
  if (releaseTrack(release.tag_name, release.prerelease === true) !== TRACK_STABLE) return { wrongTrack: true }
  return { release, source: 'api' }
}

/** 纯净轨：只能查列表接口（`/latest` 结构上不含 prerelease）。 */
async function listViaApi({ fetchImpl, track }) {
  let response
  try {
    response = await fetchImpl(API_RELEASES, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    })
  } catch (error) {
    return { fallback: true, reason: `无法连接 GitHub：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { fallback: true, reason: describeHttpFailure(response.status) }
  let releases
  try {
    releases = await response.json()
  } catch {
    return { fallback: true, reason: '发布信息解析失败。' }
  }
  const release = pickReleaseForTrack(Array.isArray(releases) ? releases : [], track)
  if (!release) return { ok: true, status: 'empty-track', source: 'api' }
  return { release, source: 'api' }
}

/**
 * 兜底：走 releases.atom。
 *
 * 为什么要它：api.github.com 未认证配额只有 60 次/小时/**IP**。校园网、公司网这类
 * NAT 共享出口很容易被别的使用者耗尽（本机实测就已被限流），届时 API 直接 403。
 * atom feed 属于网站页面、没有这个限制；拿不到资产列表就用 assetFromVersion 按
 * 确定性规则拼下载地址，更新说明从条目正文提取。
 *
 * ⚠️ atom 里没有 prerelease 标志，轨道**只能从 tag 字面量判**（tagTrack）。
 * 这条路径本机目前无法现网验证：github.com 网站域名在本地网络下不通
 * （api.github.com 通），所以它由 scripts/check-updater-tracks.mjs 用假 payload 钉住。
 */
async function viaAtom({ fetchImpl, track, platform, arch }) {
  let xml
  try {
    const response = await fetchImpl(ATOM_FEED, { headers: { 'user-agent': USER_AGENT } })
    if (!response.ok) return null
    xml = await response.text()
  } catch {
    return null
  }

  // 从 `<link ... /releases/tag/<tag>/>` 取标签，**不要**去解析 <title>：
  // 真实 Release 标题常带前后缀（如「LJANX v9.12.16 — 极简双版本开箱安装包」），
  // 按整条标题匹配 semver 会大量漏掉，于是误判成「已是最新」。
  const tags = [...String(xml).matchAll(/\/releases\/tag\/([^"'\s<>]+)/g)].map((m) => m[1])
  const latestVersion = pickVersionForTrack(tags, track)
  if (!latestVersion) return { ok: true, status: 'empty-track', source: 'atom' }

  return {
    source: 'atom',
    fields: {
      latestVersion,
      releaseUrl: `${RELEASES_PAGE}/tag/v${latestVersion}`,
      notes: notesFromAtomEntry(xml, latestVersion),
      publishedAt: '',
      asset: assetFromVersion(latestVersion, platform, arch),
    },
  }
}

// ---------------------------------------------------------------- 检查更新

/**
 * 查询指定轨道有没有新版本。
 *
 * @param {object} options
 * @param {string} options.currentVersion 本机 app.getVersion()
 * @param {string} [options.track] 想查的轨道；缺省 = 本机装的那条轨（不变量：
 *        不传就绝不跨轨，这是 v1.4.3 串台 bug 的直接教训）
 * @param {typeof fetch} [options.fetchImpl] 注入的 fetch，供门禁喂假 payload
 * @param {string} [options.platform] 供资产名匹配（默认 process.platform）
 * @param {string} [options.arch]
 * @returns {Promise<object>} status:
 *   `available`          同轨有更新，带 asset
 *   `latest`             同轨已是最新（含"本机版本更高"的降级情形）
 *   `cross-track`        查的不是本机那条轨 ⇒ 无 asset，requiresUninstall=true
 *   `no-release`         正式轨一次都没发过版
 *   `no-release-for-track` 所选轨道（多为纯净轨）还没有任何发布
 *   `ok:false`           两条路都不通，error 是人话文案
 */
export async function checkForUpdates(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const currentVersion = typeof options.currentVersion === 'string' ? options.currentVersion : ''
  const installedTrack = detectTrack(currentVersion)
  const track = options.track === TRACK_VANILLA || options.track === TRACK_STABLE
    ? options.track
    : installedTrack
  const crossTrack = track !== installedTrack

  const base = { ok: true, currentVersion, track, installedTrack, crossTrack }

  // 取源顺序：正式轨先 /releases/latest（拿不到正式轨 release 时退列表），
  // 纯净轨直接列表；任一 API 路径不通都退 atom。
  let attempt = track === TRACK_VANILLA
    ? await listViaApi({ fetchImpl, track })
    : await stableViaApi({ fetchImpl, platform, arch })
  if (attempt && attempt.wrongTrack === true) attempt = await listViaApi({ fetchImpl, track })

  let resolved = attempt
  if (!resolved || resolved.fallback === true) {
    const atom = await viaAtom({ fetchImpl, track, platform, arch })
    if (atom) resolved = atom
    else return { ok: false, error: (resolved && resolved.reason) || '检查更新失败，请稍后再试。' }
  }

  if (!resolved) return { ok: false, error: '检查更新失败，请稍后再试。' }

  // 正式轨：仓库一次正式版都没发过（/releases/latest 返回 404）
  if (resolved.status === 'no-release') {
    return { ...base, status: 'no-release', latestVersion: null, asset: null, requiresUninstall: false, source: resolved.source }
  }
  // 这条轨上一个发布都没有：装的就是这条轨 ⇒ 就是「还没发过版」（沿用旧语义）；
  // 查的是另一条轨 ⇒ 说清是"那条轨"没有，别让人以为整个项目停更了。
  if (resolved.status === 'empty-track') {
    return {
      ...base,
      status: crossTrack ? 'no-release-for-track' : 'no-release',
      latestVersion: null,
      asset: null,
      requiresUninstall: false,
      source: resolved.source,
    }
  }

  const fields = resolved.release
    ? releaseFields(resolved.release, platform, arch)
    : resolved.fields
  if (!fields || !fields.latestVersion) return { ok: false, error: '发布信息不完整，无法判断版本。' }

  // 跨轨：不比较版本号（`-vanilla.1` 相对正式版号是降级，比大小毫无意义），
  // 也不给 asset —— 面板据此只能走「先卸载」那条引导。
  if (crossTrack) {
    return {
      ...base,
      status: 'cross-track',
      ...fields,
      asset: null,
      requiresUninstall: true,
      source: resolved.source,
    }
  }

  const verdict = compareSemver(fields.latestVersion, currentVersion)
  // verdict === null 表示本机版本号不合 semver（自编译等），此时不谎报「有新版本」
  const newer = verdict !== null && verdict > 0
  return {
    ...base,
    status: newer ? 'available' : 'latest',
    ...fields,
    asset: newer ? fields.asset : null,
    requiresUninstall: false,
    source: resolved.source,
  }
}
