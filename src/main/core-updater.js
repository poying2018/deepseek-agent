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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'
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

// 这是个 ESM 模块，没有 CommonJS 的 __dirname，必须自己算
const __dirname = dirname(fileURLToPath(import.meta.url))

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
 * 解析「要更新/新增哪些包、各自从哪下」。
 *
 * ⚠️ 这里**不能只挑"已存在的包"**——第一版就是这么写的，结果用户更新到 0.1.5-rc.1 后
 * 启动即崩：新内核引入了 0.1.2-rc.1 里根本没有的 `@deepseek-ai/dsh-http-proxy`，
 * 而我们只替换旧包、从不装新包，于是 `ERR_MODULE_NOT_FOUND`。
 *
 * 正确做法：从「已装的整条锁步线」出发，沿目标版本的 dependencies /
 * optionalDependencies / peerDependencies **递归求闭包**，把新引入的包一并纳入。
 *
 * 版本选择分两类，别混：
 *   · 锁步包（`dsh-*`，spec 指向同一条版本线）→ **直接用内核目标版本**。
 *     刻意不做 semver 范围解析：`^0.1.5-rc.1` 用 maxSatisfying 会漂到 0.1.6-alpha.1，
 *     把内核混成两条预发布线（实测过）。
 *   · 独立版本线的包（如 node-addon-system 声明 `^0.1.2`）→ 按声明范围求最高匹配版本。
 */
/**
 * 取某个包某个版本的元数据。带重试，并**严格区分三种结果**：
 *   `{ meta }`      成功
 *   `{ notFound:true }` 404 —— 确定性的「这个版本不存在」，不重试
 *   `{ error:true }`    网络/限流失败（重试后仍失败）
 *
 * ⚠️ 为什么必须区分：一次计划要发 200+ 个请求，registry 偶发超时很正常。
 * 第一版把所有失败都当 `null`，于是「网络抖动」和「这个包真的没有」成了一个结果——
 * 表现就是同一次计划每次跑报缺的包还不一样（1 个 / 5 个）。这跟我们要修的
 * 那个 bug 是同一类错误：**悄悄产出一份不完整的计划**。宁可明确报「网络不稳，请重试」。
 */
async function fetchVersionMeta(name, version, attempt = 0) {
  let response
  try {
    response = await fetch(`${NPM_REGISTRY}/${name}/${version}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    })
  } catch {
    if (attempt >= 5) return { error: true }
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
    return fetchVersionMeta(name, version, attempt + 1)
  }
  if (response.status === 404) return { notFound: true }
  if (!response.ok) {
    if (attempt >= 5) return { error: true }
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
    return fetchVersionMeta(name, version, attempt + 1)
  }
  try {
    const meta = await response.json()
    return {
      meta: {
        version: meta.version,
        dependencies: meta.dependencies || {},
        optionalDependencies: meta.optionalDependencies || {},
        peerDependencies: meta.peerDependencies || {},
        tarball: meta.dist && meta.dist.tarball,
        unpackedSize: Number(meta.dist && meta.dist.unpackedSize) || 0,
      },
    }
  } catch {
    if (attempt >= 5) return { error: true }
    return fetchVersionMeta(name, version, attempt + 1)
  }
}

/**
 * 这个依赖声明是否「已经覆盖了内核目标版本」——是的话就直接用目标版本，不做范围解析。
 *
 * 用 `semver.satisfies(targetVersion, spec)` 而不是自己比 major.minor：
 * 后者会把 `^0.1.2`（稳定线）误判成锁步依赖，然后去请求根本不存在的
 * `0.1.5-rc.1`（实测：@deepseek-ai/node-addon-system 就是这么被误报成缺失的）。
 */
function isLockstepSpec(spec, targetVersion) {
  if (typeof spec !== 'string' || spec.trim() === '') return false
  try {
    return semver.satisfies(targetVersion, spec)
  } catch {
    return false
  }
}

/** 独立版本线：按声明范围求最高匹配版本（含预发布）。 */
/** 独立版本线：按声明范围求最高匹配版本（含预发布）。同样区分三态。 */
async function resolveExternalVersion(name, spec) {
  let response
  try {
    response = await fetch(`${NPM_REGISTRY}/${name}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    })
  } catch {
    return { error: true }
  }
  if (response.status === 404) return { notFound: true }
  if (!response.ok) return { error: true }
  try {
    const meta = await response.json()
    const versions = Object.keys(meta.versions || {})
    const version = semver.maxSatisfying(versions, spec, { includePrerelease: true })
      || (meta['dist-tags'] && meta['dist-tags'].latest)
    return version ? { version } : { notFound: true }
  } catch {
    return { error: true }
  }
}

export async function planCoreUpdate(targetVersion, options = {}) {
  const currentVersion = options.currentVersion || installedCoreVersion()
  if (!currentVersion) return { ok: false, error: '读不到本机内核版本。' }
  if (typeof targetVersion !== 'string' || targetVersion.trim() === '') {
    return { ok: false, error: '缺少目标版本号。' }
  }
  const verdict = compareSemver(targetVersion, currentVersion)
  if (verdict === null) return { ok: false, error: `看不懂的版本号：${targetVersion}` }
  if (verdict <= 0) {
    return { ok: false, error: `目标版本 ${targetVersion} 不比当前 ${currentVersion} 新。` }
  }

  const installed = listInstalledCorePackages()
  if (installed.length === 0) return { ok: false, error: '没有找到可更新的官方包。' }
  const installedMap = new Map(installed.map((p) => [p.name, p.version]))

  // 起点：已装的整条锁步线（版本等于当前内核版本的这批）
  const seed = installed.filter((p) => p.version === currentVersion).map((p) => p.name)
  if (seed.length === 0) return { ok: false, error: '没有找到与内核同版本的包，无法整组更新。' }

  const chosen = new Map()         // name -> { to, tarball, unpackedSize }
  const externalNeeds = new Map()  // name -> spec（独立版本线且当前缺失）
  const retired = []               // 已装、但目标版本确实没有（新版删掉了），跳过即可
  const brokenDeps = []            // 被依赖发现、目标版本却没有 → 绝不能继续
  const networkErrors = []         // 网络失败 → 绝不静默跳过
  const externalMissing = new Map() // 第三方依赖缺少（本更新装不了）→ 提前拒绝

  let frontier = seed.map((name) => ({ name, version: targetVersion, isSeed: true }))
  let rounds = 0

  while (frontier.length > 0 && rounds < 16) {
    rounds += 1
    // 一次遍历里同时拿到元数据，tarball 也一并留下，避免后面再发一轮重复请求
    const results = await mapWithConcurrency(frontier, CONCURRENCY, async (item) => (
      { item, res: await fetchVersionMeta(item.name, item.version) }
    ))
    const next = []
    for (const { item, res } of results) {
      if (res.error) { networkErrors.push(`${item.name}@${item.version}`); continue }
      if (res.notFound) {
        // 种子缺 = 新版下架了旧包（正常，跳过）；依赖缺 = 真问题（放弃）
        if (item.isSeed) retired.push(item.name)
        else brokenDeps.push(`${item.name}@${item.version}`)
        continue
      }
      const meta = res.meta
      if (chosen.has(item.name)) continue
      chosen.set(item.name, { to: item.version, tarball: meta.tarball, unpackedSize: meta.unpackedSize })

      for (const [dep, spec] of Object.entries({ ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies })) {
        if (!dep.startsWith(`${CORE_SCOPE}/`)) continue
        if (chosen.has(dep) || next.some((n) => n.name === dep)) continue
        if (isLockstepSpec(spec, targetVersion)) {
          next.push({ name: dep, version: targetVersion, isSeed: false })
        } else if (!installedMap.has(dep)) {
          externalNeeds.set(dep, spec)
        }
        // 独立版本线但已装的：沿用现状，不参与本次更新
      }

      // 新版内核可能还要旧版没有的**第三方**包（实测踩过：0.1.5 的
      // @deepseek-ai/dsh-attachment-local 需要 sharp，而构建配置把它排除了，
      // 结果内核启动就报 Could not load the "sharp" module）。
      // 本更新只管 @deepseek-ai/*，装不了第三方包，所以这里只做「存在性」检查，
      // 缺了就**提前拒绝**，不要等内核启动时才炸。
      // 只查 dependencies，不含 optional —— 可选依赖允许缺席（平台相关的二进制大量是这种）。
      for (const dep of Object.keys(meta.dependencies)) {
        if (dep.startsWith(`${CORE_SCOPE}/`)) continue
        if (externalMissing.has(dep)) continue
        if (!existsSync(join(appNodeModulesDir(), dep))) externalMissing.set(dep, item.name)
      }
    }
    frontier = next
  }

  if (networkErrors.length > 0) {
    return {
      ok: false,
      error: `查询官方源时有 ${networkErrors.length} 个请求失败（网络或限流），已放弃以免产出不完整的计划。请稍后重试。`,
      failures: networkErrors.slice(0, 8),
    }
  }
  if (brokenDeps.length > 0) {
    return {
      ok: false,
      error: `官方源在 ${targetVersion} 缺少被其他包依赖的组件，已放弃更新以免内核混版。`,
      missing: brokenDeps.slice(0, 12),
    }
  }
  if (externalMissing.size > 0) {
    const list = [...externalMissing].slice(0, 8).map(([dep, by]) => `${dep}（${by.split('/').pop()} 需要）`)
    return {
      ok: false,
      error: `新版内核还需要本机没有的依赖，装上也会起不来，已提前放弃：${list.join('；')}。`
        + '这通常是安装包本身缺了该依赖（例如构建时把平台二进制过滤掉了），请安装最新的应用本体后再试。',
      externalMissing: [...externalMissing.keys()],
    }
  }
  if (chosen.size === 0) return { ok: false, error: '没有解析出任何需要更新的包。' }

  // 独立版本线的缺失包：按声明范围解析，并单独取一次下载地址
  for (const [name, spec] of externalNeeds) {
    const resolved = await resolveExternalVersion(name, spec)
    if (resolved.error) return { ok: false, error: `解析 ${name}（要求 ${spec}）时网络失败，请稍后重试。` }
    if (resolved.notFound) return { ok: false, error: `无法为 ${name}（要求 ${spec}）确定可用版本，已放弃。` }
    const metaRes = await fetchVersionMeta(name, resolved.version)
    if (metaRes.error) return { ok: false, error: `取 ${name}@${resolved.version} 的信息时网络失败，请稍后重试。` }
    chosen.set(name, {
      to: resolved.version,
      tarball: metaRes.meta ? metaRes.meta.tarball : null,
      unpackedSize: metaRes.meta ? metaRes.meta.unpackedSize : 0,
    })
  }

  const packages = [...chosen].map(([name, info]) => ({
    name,
    from: installedMap.get(name) || null, // null = 目标版本新增的包
    to: info.to,
    tarball: info.tarball,
    unpackedSize: info.unpackedSize,
  }))

  const noTarball = packages.filter((p) => !p.tarball).map((p) => p.name)
  if (noTarball.length > 0) {
    return { ok: false, error: `以下包取不到下载地址，已放弃：${noTarball.slice(0, 8).join(', ')}` }
  }

  return {
    ok: true,
    targetVersion,
    currentVersion,
    packages,
    count: packages.length,
    added: packages.filter((p) => p.from === null).length,
    retired, // 目标版本已下架、本次跳过的旧包
    unpackedSize: packages.reduce((sum, p) => sum + p.unpackedSize, 0),
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
 * 备份根目录。
 *
 * ⚠️ 刻意放在 `node_modules` **之外**，而不是留成 `@deepseek-ai/<name>.bak-<ver>`。
 * 第一版就是留在原地，结果 214 个备份目录全堆在 `@deepseek-ai/` 里 ——
 * 那是**会被扫描的命名空间**，插件清单与客户端模块加载会看到一堆同名包目录。
 * 放到 `<resources>/.dsh-core-backup/<旧版本>/`：既不在扫描范围，又与应用同盘（rename 瞬时）。
 */
function backupRoot(oldVersion) {
  return join(appNodeModulesDir(), '..', '.dsh-core-backup', oldVersion)
}

// ---------------------------------------------------------------- 兼容补丁

/**
 * 已确认的上游内核回归 —— 替换后必须就地修补，否则内核起不来。
 *
 * 每条都要写清三件事：影响哪些版本、症状是什么、上游做了什么。
 * 只对 `appliesTo` 为真的版本动手；找不到目标代码时**不报错**，交给
 * 后面的启动冒烟验证去判断（上游将来改了写法或修好了，都不该被这里卡住）。
 */
export const CORE_COMPAT_PATCHES = [
  {
    id: 'connection-inject-webServer',
    file: 'dsh-client-connection/lib/index.js',
    appliesTo: (version) => {
      try { return semver.gte(version, '0.1.5-rc.1') } catch { return false }
    },
    find: 'inject = ["credentials"]',
    replace: 'inject = ["webServer", "credentials"]',
    why:
      '上游 0.1.5-rc.1 起把 dsh-client-connection 的 inject 从 ["webServer","credentials"] '
      + '改成了 ["credentials"]，但 register() 里仍然写 owner.effect(() => owner.webServer.register(route))，'
      + '而 owner = this.ctx（Connection 自己的上下文）。自己删了依赖却还在用，导致任何调用 '
      + 'ctx.connection.rpc.handle() 的插件都会让内核启动即崩：'
      + 'cannot get property "webServer" without inject。0.1.5-rc.2 与 0.1.6-alpha.1 同样没修。',
  },
]

/**
 * 把兼容补丁打到**暂存区**（而不是已安装目录）。
 *
 * 打在暂存区的好处：一旦后续校验或启动验证失败，回滚是把整个目录换回去，
 * 补丁自然一起撤销，不需要单独记录「补丁前的内容」。
 *
 * @returns {{applied:string[], skipped:string[], uncertain:string[]}}
 */
export function applyCoreCompatPatches(stagedDir, targetVersion) {
  const result = { applied: [], skipped: [], uncertain: [] }
  for (const patch of CORE_COMPAT_PATCHES) {
    if (!patch.appliesTo(targetVersion)) continue
    const file = join(stagedDir, patch.file)
    if (!existsSync(file)) {
      result.uncertain.push(`${patch.id}(文件缺失: ${patch.file})`)
      continue
    }
    const raw = readFileSync(file, 'utf8')
    if (raw.includes(patch.replace)) {
      result.skipped.push(patch.id) // 已经是修好的形态（重复执行 / 上游修好）
      continue
    }
    if (!raw.includes(patch.find)) {
      // 上游换了写法：不猜，交给启动验证裁决
      result.uncertain.push(`${patch.id}(找不到目标代码)`)
      continue
    }
    writeFileSync(file, raw.replace(patch.find, patch.replace))
    result.applied.push(patch.id)
  }
  return result
}

/**
 * 把暂存区替换进应用目录。
 *
 * 顺序（**逐个包**进行）：备份 → 换新 → 下一个；全部落地后再做一次校验。
 * 任一步失败（含校验不过），把已动过的**全部还原**再返回错误——
 * 宁可保持旧内核，不可留混版。
 *
 * @param {object} plan
 * @param {string} stagedDir
 * @param {{onProgress?: (p: {done: number, total: number, percent: number}) => void}} [options]
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

  // 先给暂存区打上游回归的兼容补丁（打在暂存区，回滚天然生效）
  let compat
  try {
    compat = applyCoreCompatPatches(stagedDir, plan.targetVersion)
  } catch (error) {
    return { ok: false, error: `处理兼容补丁时出错：${error instanceof Error ? error.message : String(error)}` }
  }
  if (compat.uncertain.length > 0) {
    console.warn('[core-updater] 以下兼容补丁无法确认，将由启动验证裁决:', compat.uncertain.join(', '))
  }

  // ⚠️ 记录的是「已经动过的包」，必须在**备份之后、换新之前**就 push。
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
        const dir = backupRoot(pkg.from || plan.currentVersion)
        mkdirSync(dir, { recursive: true })
        backup = join(dir, short)
        rmSync(backup, { recursive: true, force: true })
        movePath(live, backup)
      }
      touched.push({ short, live, backup })

      movePath(staged, live) // 跨盘时内部已回落为「复制 + 删源」

      done += 1
      if (typeof onProgress === 'function') {
        onProgress({ done, total, percent: Math.floor((done / total) * 100) })
      }
    }

    // 落地校验：盘上每个包的版本必须真的等于目标版本。
    // 这一步是为了兜住「依赖闭包算漏了」或「解包不完整」——用户就是因为漏装
    // 18 个新包才启动即崩（ERR_MODULE_NOT_FOUND）。宁可在这里发现并回滚。
    const bad = []
    for (const pkg of plan.packages) {
      const short = pkg.name.slice(CORE_SCOPE.length + 1)
      try {
        const written = JSON.parse(readFileSync(join(scopeDir, short, 'package.json'), 'utf8'))
        if (written.version !== pkg.to) bad.push(`${short}(期望 ${pkg.to} 实际 ${written.version})`)
      } catch {
        bad.push(`${short}(读不到 package.json)`)
      }
    }
    if (bad.length > 0) throw new Error(`落地校验未通过：${bad.slice(0, 6).join(', ')}`)

    // 启动冒烟验证：文件都对，不代表内核真能起来。这一步是唯一能证明
    // 「这次更新没把应用搞坏」的办法（详见 verifyCoreBoots 的说明）。
    if (typeof options.verifyBoot === 'function') {
      if (typeof onProgress === 'function') {
        onProgress({ done: total, total, percent: 100, stage: 'verify' })
      }
      const smoke = await options.verifyBoot()
      if (!smoke || smoke.ok !== true) {
        throw new Error(`更新后内核无法启动，已回滚。${(smoke && smoke.error) || '（无详情）'}`)
      }
    }
  } catch (error) {
    // 回滚：倒序把 touched 里每一项还原（先清掉可能已落地的内容，再把备份移回来）
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
      // 回滚也没成功：必须让用户知道哪些包只剩备份，别静默装作没事
      const where = backupRoot(plan.currentVersion || 'backup')
      return {
        ok: false,
        error: `${reason}；且以下包还原失败，请手动从 ${where} 把同名目录移回 node_modules/@deepseek-ai/：${failed.join(', ')}`,
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
    backupRoot: backupRoot(plan.currentVersion),
    compat,
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

// ---------------------------------------------------------------- 冒烟验证

/**
 * 启动一次内核，确认它真的能起来。
 *
 * ⚠️ 这是**唯一**能证明「这次更新没把应用搞坏」的办法。实测踩过两次：
 *   1. 新版内核引入了旧版没有的包 → 启动时 ERR_MODULE_NOT_FOUND
 *   2. 上游 0.1.5+ 的 dsh-client-connection 删掉了自己 inject 里的 webServer
 *      却仍在使用 → 任何用 ctx.connection.rpc.handle() 的插件都让内核起不来
 * 两者都**不是**「下载/替换失败」，只靠版本号和文件校验根本发现不了。
 * 所以替换完必须真启动一次；起不来就整组回滚，把错误原样报给用户。
 *
 * 就绪信号用内核 stdout 里的 `token=` 那一行（`dsh web: http://.../?token=...`），
 * 这是它自己打的成功标志，比「进程还活着」可靠。
 *
 * @param {{dshHome?:string, cwd?:string, timeoutMs?:number}} options
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function verifyCoreBoots(options = {}) {
  const binScript = join(appNodeModulesDir(), CORE_PACKAGE, 'lib', 'bin.js')
  if (!existsSync(binScript)) {
    return { ok: false, error: `找不到内核入口：${binScript}` }
  }

  const { spawn } = await import('node:child_process')
  const { createServer } = await import('node:net')

  // 借系统要一个空闲端口，避免和正在运行的内核撞车
  const port = await new Promise((resolve) => {
    const probe = createServer()
    probe.on('error', () => resolve(0))
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address() && probe.address().port
      probe.close(() => resolve(assigned || 0))
    })
  })
  if (!port) return { ok: false, error: '找不到空闲端口做启动验证。' }

  const env = {
    ...process.env,
    // 与应用拉起内核时保持一致：Electron 二进制当无界面 Node 用
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: options.dshHome || process.env.DSH_HOME || '',
    DSH_PORT: String(port),
    PORT: String(port),
    DSH_DESKTOP_ISOLATED: '1',
    NODE_ENV: 'production',
  }

  let child
  try {
    child = spawn(
      process.execPath,
      ['--expose-internals', binScript, 'web', '--port', String(port), '--no-open'],
      { env, cwd: options.cwd || app.getPath('home'), stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (error) {
    return { ok: false, error: `无法启动内核做验证：${error instanceof Error ? error.message : String(error)}` }
  }

  const timeoutMs = Number(options.timeoutMs) || 180000
  let stdout = ''
  let stderr = ''

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: `内核在 ${Math.round(timeoutMs / 1000)}s 内没有就绪（超时）` })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      // 内核就绪时会打出带 token 的地址，用它做成功判据
      if (stdout.includes('token=')) finish({ ok: true })
    })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      finish({ ok: false, error: `无法启动内核：${error.message}` })
    })
    // ⚠️ 必须用 close 而不是 exit：exit 触发时 stdio 管道里可能还有没读完的数据，
    // 用 exit 会拿到空的 stderr，用户就只能看到「退出码 1」而不知道真正原因。
    child.on('close', (code, signal) => {
      const detail = (stderr || stdout).split('\n').map((l) => l.trim()).filter(Boolean).slice(-8).join('\n')
      finish({
        ok: false,
        error: `内核启动失败（退出码 ${code}${signal ? ` / ${signal}` : ''}）${detail ? `：\n${detail}` : ''}`,
      })
    })
  })
}
