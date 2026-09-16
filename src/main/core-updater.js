/**
 * 核心（DSH 内核）更新。
 *
 * 与应用本体更新（`updater.js`）的三点关键差异：
 *
 * 1. **源不同** —— 走 npm 官方源（registry.npmjs.org），不是本仓库的 GitHub Release。
 * 2. **日志不同** —— npm 不提供 changelog。改从官方仓库 `deepseek-harness` 的
 *    `releases.atom` 取各版本发布正文：它的 `<content>` 里带全文，且**不吃**
 *    api.github.com 那 60 次/小时/IP 的配额（本机实测那个配额早已被耗尽）。
 * 3. **应用方式不同** —— 内核是 200+ 个**同版本锁步发布**的 `@deepseek-ai/*` 包，
 *    只换主包必然混版崩溃。做法是整组下载到暂存区 → 逐个校验 → 备份原目录 →
 *    就地替换 → 任一步失败全部回滚 → 提示用户重启应用生效。
 *
 * ⚠️ 频道语义：这里**不**过滤预发布。因为本发行版自己就锁在 `0.1.2-rc.1` 这条
 * 预发布线上，若按常规「只认正式版」处理，用户永远看不到内核更新。
 */

import { app } from 'electron'
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { compareSemver } from './updater.js'

export const CORE_PACKAGE = '@deepseek-ai/dsh'
export const CORE_SCOPE = '@deepseek-ai'
export const CORE_REPO_OWNER = 'deepseek-ai'
export const CORE_REPO_NAME = 'deepseek-harness'
export const CORE_RELEASES_PAGE = `https://github.com/${CORE_REPO_OWNER}/${CORE_REPO_NAME}/releases`

const NPM_REGISTRY = 'https://registry.npmjs.org'
const CORE_ATOM = `https://github.com/${CORE_REPO_OWNER}/${CORE_REPO_NAME}/releases.atom`
const USER_AGENT = 'DeepSeek-Agent-Desktop-Updater'
/** 200+ 个包全串行太慢、全并发又会打满连接，取中间值 */
const CONCURRENCY = 8

// ---------------------------------------------------------------- 路径

/** 打包后内核在 `resources/node_modules`；开发态在仓库根的 `node_modules`。 */
export function appNodeModulesDir() {
  if (app.isPackaged) return join(process.resourcesPath, 'node_modules')
  return join(__dirname, '..', '..', 'node_modules')
}

function coreScopeDir() {
  return join(appNodeModulesDir(), CORE_SCOPE)
}

/**
 * 暂存区位置：**优先放在目标所在的分区**。
 *
 * 为什么：应用常常装在 D 盘（`D:\dsh\DeepSeek Agent`），而 `userData` 在 C 盘的
 * `%APPDATA%`。跨盘的 `rename()` 会抛 EXDEV，只能退化成「复制 + 删除」——
 * 214 个包要白复制几百 MB。把暂存区放到 `resources/node_modules/.dsh-core-update/`
 * 就让最后那步是同盘 rename，瞬时完成。
 *
 * 目录名以点开头，且不在 `@deepseek-ai/` 下，不会被 `listInstalledCorePackages()` 误认成已装包。
 * 应用目录不可写时（如 macOS 的 /Applications）自动退回 userData——此时靠 movePath 的跨盘回落兜底。
 */
function stagingRoot(targetVersion) {
  const beside = join(appNodeModulesDir(), '.dsh-core-update')
  try {
    mkdirSync(beside, { recursive: true })
    writeFileSync(join(beside, '.probe'), '')
    rmSync(join(beside, '.probe'), { force: true })
    return join(beside, targetVersion)
  } catch {
    return join(app.getPath('userData'), 'core-update', targetVersion)
  }
}

// ---------------------------------------------------------------- 本机内核

/**
 * 扫描已安装的全部 `@deepseek-ai/*` → [{ name, version }]。
 *
 * 版本号等于主包版本的那批就是「内核本体 + 全部卫星包」（本机实测 214 个）；
 * 其余（cordis / schemastery 等）版本线独立，**不参与**内核更新。
 */
export function listInstalledCorePackages() {
  const dir = coreScopeDir()
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const pkgJson = join(dir, entry, 'package.json')
    if (!existsSync(pkgJson)) continue
    try {
      const parsed = JSON.parse(readFileSync(pkgJson, 'utf8'))
      if (parsed && typeof parsed.version === 'string') {
        out.push({ name: `${CORE_SCOPE}/${entry}`, version: parsed.version })
      }
    } catch {
      /* 目录损坏的包跳过，不参与更新 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 本机装的内核版本；读不到返回 null。 */
export function installedCoreVersion() {
  const hit = listInstalledCorePackages().find((p) => p.name === CORE_PACKAGE)
  return hit ? hit.version : null
}

// ---------------------------------------------------------------- 检查

/** 取「版本 → 发布正文」。解析 `<content>` 而不是 `<title>`。 */
async function fetchCoreReleaseNotes() {
  const notes = new Map()
  try {
    const response = await fetch(CORE_ATOM, { headers: { 'user-agent': USER_AGENT } })
    if (!response.ok) return notes
    const xml = await response.text()
    for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const link = entry.match(/\/releases\/tag\/([^"'\s<>]+)/)
      if (!link) continue
      const version = decodeURIComponent(link[1]).replace(/^dsh-v/i, '').replace(/^v/i, '')
      const content = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)
      const updated = entry.match(/<updated>([\s\S]*?)<\/updated>/)
      let body = ''
      if (content) {
        body = content[1]
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
          .replace(/<[^>]+>/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      }
      notes.set(version, { body, updated: updated ? updated[1].trim() : '' })
    }
  } catch {
    /* 取不到正文不算失败：下面会退化成「只有版本 + 时间」的日志 */
  }
  return notes
}

/**
 * 查询内核是否有更新。
 *
 * @returns {{ok:boolean, status?:'latest'|'available', currentVersion?:string,
 *            latestVersion?:string, changelog?:Array<{version,date,notes}>, error?:string}}
 */
export async function checkCoreUpdate(options = {}) {
  const currentVersion = options.currentVersion || installedCoreVersion()
  if (!currentVersion) return { ok: false, error: '读不到本机内核版本，无法检查核心更新。' }

  let meta
  try {
    const response = await fetch(`${NPM_REGISTRY}/${CORE_PACKAGE}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    })
    if (!response.ok) return { ok: false, error: `查询官方源失败（HTTP ${response.status}）。` }
    meta = await response.json()
  } catch (error) {
    return { ok: false, error: `无法连接 npm 官方源：${error instanceof Error ? error.message : String(error)}` }
  }

  const latestVersion = (meta['dist-tags'] && meta['dist-tags'].latest) || ''
  if (!latestVersion) return { ok: false, error: '官方源没有可用的版本标签。' }

  const base = {
    ok: true,
    currentVersion,
    latestVersion,
    releasesPage: CORE_RELEASES_PAGE,
    packageName: CORE_PACKAGE,
  }
  const verdict = compareSemver(latestVersion, currentVersion)
  if (verdict === null || verdict <= 0) return { ...base, status: 'latest', changelog: [] }

  // 「当前 → 目标」之间的日志（不含当前版本本身）
  const times = meta.time || {}
  const notes = await fetchCoreReleaseNotes()
  const changelog = Object.keys(meta.versions || {})
    .filter((v) => {
      const above = compareSemver(v, currentVersion)
      const below = compareSemver(v, latestVersion)
      return above !== null && below !== null && above > 0 && below <= 0
    })
    .sort((a, b) => compareSemver(a, b))
    .map((version) => ({
      version,
      date: times[version] || '',
      notes: (notes.get(version) || {}).body || '',
    }))

  return { ...base, status: 'available', changelog }
}

// ---------------------------------------------------------------- 计划

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 解析「要更新哪些包、各自从哪下」。
 *
 * 只挑**版本等于本机内核版本**的 `@deepseek-ai/*`（即整条锁步线），逐个确认目标
 * 版本存在。**任一缺失就整体放弃**并在错误里列出——绝不部分更新，否则内核混版。
 */
export async function planCoreUpdate(targetVersion, options = {}) {
  const currentVersion = options.currentVersion || installedCoreVersion()
  if (!currentVersion) return { ok: false, error: '读不到本机内核版本。' }

  const targets = listInstalledCorePackages().filter((p) => p.version === currentVersion)
  if (targets.length === 0) return { ok: false, error: '没有找到可更新的官方包。' }

  const resolved = await mapWithConcurrency(targets, CONCURRENCY, async (pkg) => {
    try {
      const response = await fetch(`${NPM_REGISTRY}/${pkg.name}/${targetVersion}`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      })
      if (!response.ok) return { name: pkg.name, missing: true }
      const meta = await response.json()
      const tarball = meta && meta.dist && meta.dist.tarball
      if (typeof tarball !== 'string') return { name: pkg.name, missing: true }
      return {
        name: pkg.name,
        from: pkg.version,
        to: targetVersion,
        tarball,
        unpackedSize: Number(meta.dist.unpackedSize) || 0,
      }
    } catch {
      return { name: pkg.name, missing: true }
    }
  })

  const missing = resolved.filter((r) => r.missing).map((r) => r.name)
  if (missing.length > 0) {
    return {
      ok: false,
      error: `官方源在 ${targetVersion} 缺少 ${missing.length} 个包，已放弃更新以免内核混版。`,
      missing: missing.slice(0, 12),
    }
  }

  return {
    ok: true,
    targetVersion,
    currentVersion,
    packages: resolved,
    count: resolved.length,
    unpackedSize: resolved.reduce((sum, r) => sum + r.unpackedSize, 0),
  }
}

// ---------------------------------------------------------------- 下载 + 解包

async function extractTarball(tarball, destDir) {
  const { extract } = await import('tar')
  mkdirSync(destDir, { recursive: true })
  // npm 包的 tar 里统一带一层 `package/` 前缀，strip 掉才是包根
  await extract({ file: tarball, cwd: destDir, strip: 1 })
}

/**
 * 下载全部包并解到暂存区，逐个校验版本号。
 *
 * @returns {{ok:boolean, stagedDir?:string, error?:string}}
 */
export async function downloadCoreUpdate(plan, onProgress) {
  if (!plan || plan.ok !== true) return { ok: false, error: '更新计划无效。' }
  const root = stagingRoot(plan.targetVersion)
  const tarballDir = join(root, 'tarballs')
  const stagedDir = join(root, 'staged', CORE_SCOPE)
  // 每次重下都从干净目录开始，避免上次的残包混进来
  try { rmSync(join(root, 'staged'), { recursive: true, force: true }) } catch {}
  mkdirSync(tarballDir, { recursive: true })
  mkdirSync(stagedDir, { recursive: true })

  let done = 0
  const failures = []

  await mapWithConcurrency(plan.packages, CONCURRENCY, async (pkg) => {
    const short = pkg.name.slice(CORE_SCOPE.length + 1)
    const tgz = join(tarballDir, `${short}.tgz`)
    const dest = join(stagedDir, short)
    try {
      const response = await fetch(pkg.tarball, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'follow',
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), (await import('node:fs')).createWriteStream(tgz))
      await extractTarball(tgz, dest)

      const written = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
      if (written.version !== pkg.to) {
        throw new Error(`解包后版本不符：期望 ${pkg.to}，实际 ${written.version}`)
      }
    } catch (error) {
      failures.push(`${short}: ${error instanceof Error ? error.message : String(error)}`)
    }
    done += 1
    if (typeof onProgress === 'function') {
      onProgress({ done, total: plan.packages.length, percent: Math.floor((done / plan.packages.length) * 100) })
    }
  })

  if (failures.length > 0) {
    return {
      ok: false,
      error: `${failures.length} 个包下载或解包失败，已放弃（不会改动现有内核）。`,
      failures: failures.slice(0, 10),
    }
  }
  return { ok: true, stagedDir }
}

// ---------------------------------------------------------------- 就地替换

/**
 * 移动目录，**允许跨盘**。
 *
 * ⚠️ 这个包装是必须的，不是防御性编程：应用很可能装在 D 盘
 * （如 `D:\dsh\DeepSeek Agent`），而暂存区在 `%APPDATA%`（C 盘）。
 * 此时 `rename()` 会直接抛 `EXDEV: cross-device link not permitted`——
 * 实测就是这么炸的。跨盘时退回「递归复制 + 删源」。
 */
function movePath(from, to) {
  try {
    renameSync(from, to)
    return
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error
  }
  cpSync(from, to, { recursive: true, force: true, dereference: true })
  rmSync(from, { recursive: true, force: true })
}

/**
 * 把暂存区替换进应用目录。
 *
 * 顺序（**逐个包**进行，不是先全备份再全替换）：备份 → 换新 → 下一个。
 * 任一步失败，把已动过的**全部还原**再返回错误——宁可保持旧内核，不可留混版。
 *
 * @param {object} plan
 * @param {string} stagedDir
 * @param {{onProgress?: (p:{done:number,total:number,percent:number}) => void}} [options]
 */
export async function applyCoreUpdate(plan, stagedDir, options = {}) {
  if (!plan || plan.ok !== true || !stagedDir) return { ok: false, error: '更新计划无效。' }
  const scopeDir = coreScopeDir()
  if (!existsSync(scopeDir)) return { ok: false, error: '找不到已安装的内核目录。' }

  try {
    statSync(scopeDir)
    writeFileSync(join(scopeDir, '.write-probe'), '')
    rmSync(join(scopeDir, '.write-probe'), { force: true })
  } catch {
    return { ok: false, error: '应用目录不可写（macOS 装在 /Applications 时需管理员权限），已放弃。' }
  }

  const onProgress = options.onProgress
  const total = plan.packages.length
  let done = 0

  // ⚠️ 这里记录的是「已经动过的包」，必须在**备份之后、换新之前**就 push。
  // 否则失败正好卡在这两步之间时，备份不会进入回滚列表 → 原目录改名后没人还回去，
  // 内核就少了一个包（实测踩过：@deepseek-ai/dsh 变成 dsh.bak-<ver> 后再也没还原）。
  const touched = []
  try {
    for (const pkg of plan.packages) {
      const short = pkg.name.slice(CORE_SCOPE.length + 1)
      const live = join(scopeDir, short)
      const staged = join(stagedDir, short)
      if (!existsSync(join(staged, 'package.json'))) {
        throw new Error(`暂存区缺少 ${short}`)
      }

      let backup = null
      if (existsSync(live)) {
        backup = `${live}.bak-${pkg.from}`
        rmSync(backup, { recursive: true, force: true })
        renameSync(live, backup) // 同盘（都在 node_modules 下），不会跨设备
      }
      touched.push({ short, live, backup })

      movePath(staged, live) // 这一步会跨盘 → 内部已处理 EXDEV

      done += 1
      if (typeof onProgress === 'function') {
        onProgress({ done, total, percent: Math.floor((done / total) * 100) })
      }
    }
  } catch (error) {
    // 回滚：倒序把 touched 里每一项还原（先清掉可能已落地的内容，再把备份改回来）
    const failed = []
    for (const item of touched.reverse()) {
      try { rmSync(item.live, { recursive: true, force: true }) } catch {}
      if (item.backup) {
        try { movePath(item.backup, item.live) } catch (restoreError) {
          failed.push(`${item.short}(${restoreError && restoreError.code ? restoreError.code : '未知'})`)
        }
      }
    }
    const reason = error instanceof Error ? error.message : String(error)
    if (failed.length > 0) {
      // 回滚也没成功：必须让用户知道哪些包只剩 .bak，别静默装作没事
      return {
        ok: false,
        error: `${reason}；且以下包还原失败，请手动把 <包名>.bak-${plan.currentVersion} 改回原名：${failed.join(', ')}`,
        stuck: failed,
      }
    }
    return { ok: false, error: `替换失败并已回滚：${reason}` }
  }

  return {
    ok: true,
    applied: touched.length,
    from: plan.currentVersion,
    to: plan.targetVersion,
    backups: touched.filter((t) => t.backup).map((t) => t.backup),
  }
}

/** 清理暂存区（替换成功后调用；失败时保留以便排查）。 */
export function cleanStaging(targetVersion) {
  try { rmSync(stagingRoot(targetVersion), { recursive: true, force: true }) } catch {}
  // 顺手清掉空掉的容器目录与 userData 下的旧暂存区，别在应用目录里留垃圾
  for (const dir of [join(appNodeModulesDir(), '.dsh-core-update'), join(app.getPath('userData'), 'core-update')]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}
