/**
 * 构建前把内核（@deepseek-ai/dsh 及整套锁步的 dsh-* 包）升到指定版本。
 *
 * 内核没有运行期更新轨道，它随安装包一起发布——所以「更新内核」只发生在构建之前：
 *
 *     pnpm update-core                     # 升到 latest dist-tag（默认）
 *     pnpm update-core -- --tag alpha      # 升到 alpha dist-tag
 *     pnpm update-core -- 0.1.6-alpha.2    # 升到显式版本
 *     pnpm update-core -- --sync-only      # 不升版本，只把两处 overrides 对齐到当前钉版
 *     pnpm update-core -- --dry-run        # 只打印将要做什么，不写文件、不装依赖
 *
 * 做四件事：
 *   1. 解析目标版本（**按 dist-tag 查**，不是只看 `latest`——本发行版长期跟在
 *      rc/alpha 线上，`npm view <pkg> version` 只会给你 latest 标签，
 *      在 0.1.5-rc.2 == latest 的时候等于什么都不升）；
 *   2. 把 package.json 里两个内核依赖钉到该精确版本；
 *   3. **同时**写 package.json 的 `pnpm.overrides` 和 pnpm-workspace.yaml 的
 *      `overrides`（见下）；
 *   4. pnpm install 让锁步的 200+ 个 @deepseek-ai/* 包整组落到新版本，并断言装出来的
 *      确实是目标版本。
 *
 * ⚠️ 为什么两处 overrides 都要写（这里曾是真事故）：
 *   · CI（release.yml）钉 pnpm 10 ⇒ 读 package.json 的 `pnpm.overrides`
 *   · 本地 pnpm 11+ ⇒ 只读 pnpm-workspace.yaml 的 `overrides`
 *   旧版脚本只改 package.json 一侧 ⇒ 每跑一次 update-core 就把两侧差距拉大一档，
 *   本地装出来的 dsh-llm / dsh-session-query 停在旧版 → 缺导出、启动即崩（2026-09-17
 *   那批报错的根因就是这个）。现在由本脚本负责让两侧**永远逐条相等**。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import semver from 'semver'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const pkgPath = join(rootDir, 'package.json')
const wsPath = join(rootDir, 'pnpm-workspace.yaml')

const KERNEL_MAIN = '@deepseek-ai/dsh'
const KERNEL_WEB = '@deepseek-ai/dsh-web-app'
const OVERRIDE_PREFIX = '@deepseek-ai/dsh-'

// ── 参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const takeValue = (name) => {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`${name} 需要一个值（如 --tag alpha）`)
  }
  return v
}
const explicitVersion = argv.find((a) => semver.valid(a))
const tagName = takeValue('--tag') ?? 'latest'
const syncOnly = flags.has('--sync-only')
const dryRun = flags.has('--dry-run')
const skipInstall = flags.has('--no-install')

/**
 * 以 argv 数组调用 npm，不经过 shell：
 *   · Windows 上直接 spawn `npm` / `npm.cmd` 会 ENOENT / EINVAL（Node 对 .cmd 的
 *     shell 加固），所以用当前 node 解释器跑 npm 自带的 npm-cli.js；
 *   · 找不到 npm-cli.js 时退回 shell 调用，参数仍是模块内常量，不含任何外部输入。
 */
function npmView(args) {
  const exeDir = dirname(process.execPath)
  const candidates =
    process.platform === 'win32'
      ? [join(exeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [join(exeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  for (const cli of candidates) {
    if (existsSync(cli)) {
      return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }).trim()
    }
  }
  return execSync(['npm', ...args].map((a) => JSON.stringify(a)).join(' '), { encoding: 'utf8' }).trim()
}

/** 查 npm 上的 dist-tags（含 rc/alpha 线），失败即中止而不是默默升错版本。 */
function resolveDistTags() {
  const out = npmView(['view', KERNEL_MAIN, 'dist-tags', '--json'])
  const tags = JSON.parse(out)
  if (tags === null || typeof tags !== 'object') {
    throw new Error(`npm view ${KERNEL_MAIN} dist-tags 返回了意外内容：${out}`)
  }
  return tags
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = pkg.dependencies[KERNEL_MAIN]

let target
if (syncOnly) {
  target = current
  console.log(`[update-core] --sync-only：不动版本，把两侧 overrides 对齐到当前钉版 ${target}`)
} else if (explicitVersion !== undefined) {
  target = explicitVersion
  console.log(`[update-core] 目标版本（显式）：${target}`)
} else {
  const tags = resolveDistTags()
  target = tags[tagName]
  if (target === undefined) {
    throw new Error(
      `npm 上 ${KERNEL_MAIN} 没有 '${tagName}' 这个 dist-tag。可用：${Object.keys(tags).join(', ')}`,
    )
  }
  if (!semver.valid(target)) throw new Error(`dist-tag '${tagName}' 解析出的不是合法版本号：${target}`)
  console.log(`[update-core] 目标版本（dist-tag '${tagName}'）：${target}（当前 ${current}）`)
}
if (!semver.valid(target)) throw new Error(`目标版本号不合法：${target}`)

// ── package.json：两个内核依赖 + pnpm.overrides ───────────────────────
pkg.dependencies[KERNEL_MAIN] = target
pkg.dependencies[KERNEL_WEB] = target

const overrides = pkg.pnpm?.overrides ?? {}
const wanted = new Map() // 目标 overrides 全量：key → version
let movedInPkgJson = 0
let driftedInPkgJson = 0
for (const [key, value] of Object.entries(overrides)) {
  if (!key.startsWith(OVERRIDE_PREFIX)) continue
  // 锁步设计下所有 dsh-* 覆盖值都该等于内核版本。凡是「精确版本」形态的一律带走，
  // 顺手把历史漂移（值不等于 from 的那批）也修掉，而不是把漂移继续留在原地。
  if (semver.valid(value)) {
    if (value !== current) driftedInPkgJson += 1
    if (value !== target) movedInPkgJson += 1
    wanted.set(key, target)
  } else {
    wanted.set(key, value) // 布尔/范围一类的特殊条目，原样保留
  }
}
for (const [key, value] of wanted) overrides[key] = value

// ── pnpm-workspace.yaml：只重写 overrides 块，其余内容与注释原样保留 ──
const wsRaw = readFileSync(wsPath, 'utf8')
const EOL = wsRaw.includes('\r\n') ? '\r\n' : '\n'
const wsLines = wsRaw.split(/\r?\n/)
const blockStart = wsLines.findIndex((l) => /^overrides:\s*$/.test(l))
if (blockStart === -1) throw new Error(`${wsPath} 里找不到 overrides: 块，双写约定已失效，请人工核对。`)
let blockEnd = wsLines.length
for (let i = blockStart + 1; i < wsLines.length; i += 1) {
  if (/^\S/.test(wsLines[i])) {
    blockEnd = i
    break
  }
}
const block = wsLines.slice(blockStart + 1, blockEnd)
const entryRe = /^(\s*)'(@deepseek-ai\/[^']+)':\s*(.+?)\s*$/
const seen = new Set()
let lastKernelLine = -1
const rewritten = block.map((line, idx) => {
  const m = line.match(entryRe)
  if (m === null) return line
  const [, indent, key] = m
  if (!key.startsWith(OVERRIDE_PREFIX)) return line
  seen.add(key)
  lastKernelLine = idx
  return `${indent}'${key}': ${target}`
})
const missing = [...wanted.keys()].filter((k) => k.startsWith(OVERRIDE_PREFIX) && !seen.has(k))
if (missing.length > 0) {
  const insertAt = lastKernelLine + 1
  const added = missing.map((k) => `  '${k}': ${target}`)
  rewritten.splice(insertAt, 0, `  # ── 由 update-core 补齐（与 package.json pnpm.overrides 对齐） ──`, ...added)
}
const nextWs = wsLines.slice(0, blockStart + 1).concat(rewritten, wsLines.slice(blockEnd)).join(EOL)
const movedInWorkspace = seen.size + missing.length

console.log(
  `[update-core] overrides：package.json 更新 ${movedInPkgJson} 条` +
    (driftedInPkgJson > 0 ? `（其中 ${driftedInPkgJson} 条原本就与钉版不一致，已一并修正）` : '') +
    `；pnpm-workspace.yaml 覆盖 ${movedInWorkspace} 条（补写缺失 ${missing.length} 条）`,
)

// ── 一致性自检：两侧必须逐条相等，否则不装依赖 ────────────────────────
function parseWorkspaceOverrides(text) {
  const out = new Map()
  let inside = false
  for (const line of text.split(/\r?\n/)) {
    if (/^overrides:\s*$/.test(line)) {
      inside = true
      continue
    }
    if (inside && /^\S/.test(line)) inside = false
    if (!inside) continue
    const m = line.match(entryRe)
    if (m !== null) out.set(m[2], m[3])
  }
  return out
}
const wsOverrides = parseWorkspaceOverrides(nextWs)
const mismatch = [...wanted.entries()].filter(([k, v]) => wsOverrides.get(k) !== v)
if (mismatch.length > 0) {
  throw new Error(
    `两处 overrides 仍不一致，拒绝继续：\n  ${mismatch.map(([k, v]) => `${k}：package.json=${v} yaml=${wsOverrides.get(k)}`).join('\n  ')}`,
  )
}

if (dryRun) {
  console.log('[update-core] --dry-run：未写入任何文件。')
  process.exit(0)
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
writeFileSync(wsPath, nextWs)

if (skipInstall) {
  console.log(`[update-core] --no-install：已写入两处清单，目标 ${target}，未装依赖。`)
  process.exit(0)
}
console.log(`[update-core] 内核依赖：${current} → ${target}，开始 pnpm install…`)
execSync('pnpm install --no-frozen-lockfile', { cwd: rootDir, stdio: 'inherit' })

const readInstalled = (name) =>
  JSON.parse(readFileSync(join(rootDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version
const installedMain = readInstalled(KERNEL_MAIN)
// 抽查一个只靠 overrides 才锁步的成员包：它最能暴露「只换主包」的老问题。
const installedMember = readInstalled('@deepseek-ai/dsh-session')
console.log(`[update-core] 完成：${KERNEL_MAIN}=${installedMain}，${KERNEL_MAIN.replace('dsh', 'dsh-session')}=${installedMember}`)
if (installedMain !== target || installedMember !== target) {
  throw new Error(
    `期望两处都是 ${target}，实际 ${installedMain} / ${installedMember} —— 检查 pnpm 版本读的是哪一份 overrides。`,
  )
}
