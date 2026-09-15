/**
 * 社区插件与宿主依赖的 peer 兼容性守门检查（`npm run check:plugins`）。
 *
 * 为什么需要它：`prepare-bundle.js` 对 npm 插件只做 `npm pack` + 解包，
 * **不安装、不校验 peerDependencies**。于是「插件声明的 peer 范围不覆盖宿主
 * 实际装的版本」这件事不会有任何构建报错——插件照常打进发行版，直到运行期
 * 某个 import 失败才暴露。这与本仓库踩过的 Cordis 补丁静默失效是同一类问题：
 * **配置/依赖写了，但与现实不符，且没人报错。**
 *
 * 本脚本把它变成断言：静态对比「插件声明的 peer 范围」与「宿主锁文件解析出的
 * 实际版本」，不联网、不安装、零依赖。
 *
 * 两个输入都是本地文件：
 *   · 插件的 package.json —— 优先取 bundle-runtime/plugins/<name>/（prepare-bundle
 *     的产物，即真正会进发行版的那份），缺失时回退到 npm 缓存目录；
 *   · 宿主的解析版本 —— pnpm-lock.yaml 里 `'<pkg>@<ver>'` 形式的锁定条目。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '⚠️ '} ${label}${ok || !extra ? '' : `\n       ${extra}`}`)
  if (!ok) failures += 1
}

/**
 * 已知且**已接受**的 peer 声明偏差。键为 `<插件名>|<依赖名>`。
 *
 * 只登记「已人工确认过、当前无害」的项，并把确认依据写清楚。登记在这里的
 * 偏差不再让脚本失败，但会以 ℹ️ 打印出来——于是**新的**漂移仍然会报警。
 * 每次 DSH 内核或插件版本变动后应重新审视本表。
 */
const ACCEPTED_PEER_DRIFT = {
  'dsh-connect-workbuddy|@earendil-works/pi-ai': {
    declared: '>=0.85.0 <0.86.0',
    hostLocked: '0.84.4',
    reason: [
      '插件把它随 2.0.0/2.0.1 一起抬到 0.85，但同一版的 @deepseek-ai/* 范围又写明接受',
      '本发行版的 0.1.2-rc.1，二者自相矛盾；实测为「声明保守」而非真实损坏。',
      '已确认插件只用到两个 pi-ai API，且两版本一致：',
      '  · createProvider —— 签名逐字符一致，CreateProviderOptions 完全一致；',
      '  · openAICompletionsApi（./api/openai-completions.lazy）—— 文件两版本都在，',
      '    exports 的 "./api/*" 通配相同。',
      'models.d.ts / api/openai-completions.d.ts 的差异纯为新增（streamDeferred、',
      'vllmPriority），无破坏性改动。并已用真实 pi-ai 0.84.4 按插件的精确入参形态',
      '跑通 createProvider 装配（见 plugins.manifest.yaml 中该条目的注释）。',
      '回退方案：钉 dsh-connect-workbuddy@1.2.0（其 pi-ai 范围明写接受 >=0.82.1 <0.85.0），',
      '代价是丢掉国际版支持（1.4.0 才加入）与 2.0.1 的关键修复。',
    ].join('\n       '),
  },
}

// ── 解析 plugins.manifest.yaml（与 prepare-bundle.js 同一套简化 schema）──
function parseManifest(file) {
  const plugins = []
  let cur = null
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const item = line.match(/^\s*-\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/)
    const kv = line.match(/^\s*(name|repo|ref|npm):\s*['"]?([^'"\s]+)['"]?\s*$/)
    if (item) {
      cur = { name: item[1] }
      plugins.push(cur)
    } else if (kv && cur) {
      if (kv[1] === 'repo') cur.repo = kv[2]
      if (kv[1] === 'ref') cur.ref = kv[2]
      if (kv[1] === 'npm') cur.npm = kv[2]
    }
  }
  return plugins
}

// ── 从 pnpm-lock.yaml 取某包实际解析出的版本 ──
function lockedVersion(lockText, pkg) {
  // 形如：  '@earendil-works/pi-ai@0.84.4':
  // 末尾允许跟 peer 后缀，例如 @0.84.4(...)，只取到版本号为止
  const re = new RegExp(`^ {2}'${pkg.replace(/[/@]/g, (c) => c)}@([0-9][^'(:]*)[^']*':`, 'm')
  const m = lockText.match(re)
  return m ? m[1] : null
}

// ── 极简 semver：判断 version 是否落在 range 内（只支持本仓库用到的形式）──
// 支持 ">=a <b" 与用 "||" 连接的多个区间。够用即可，不引依赖。
function parseVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null }
}
function compare(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // 预发布版本低于同号正式版；两者都带 pre 时按字符串比（本仓库场景足够）
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return a.pre < b.pre ? -1 : 1
}
function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v) return false
  return String(range)
    .split('||')
    .some((clause) => {
      const parts = clause.trim().split(/\s+/).filter(Boolean)
      // 单条 ">=x.y.z" 之类
      if (parts.length === 0) return false
      return parts.every((part) => {
        const m = part.match(/^(>=|<=|>|<|\^|~)?\s*([0-9][^\s]*)$/)
        if (!m) return false
        const op = m[1] ?? '='
        const t = parseVersion(m[2])
        if (!t) return false
        const c = compare(v, t)
        switch (op) {
          case '>=': return c >= 0
          case '>': return c > 0
          case '<=': return c <= 0
          case '<': return c < 0
          case '=': return c === 0
          case '^': return c >= 0 && v.major === t.major
          case '~': return c >= 0 && v.major === t.major && v.minor === t.minor
          default: return false
        }
      })
    })
}

const manifestPath = join(root, 'plugins.manifest.yaml')
const lockPath = join(root, 'pnpm-lock.yaml')
const plugins = parseManifest(manifestPath)
const npmPlugins = plugins.filter((p) => p.npm)

console.log(`\n📦 插件 peer 兼容性检查（共 ${plugins.length} 个插件，其中 npm 发行包 ${npmPlugins.length} 个）`)

if (!existsSync(lockPath)) {
  console.log('  ⏭️  跳过：未找到 pnpm-lock.yaml，无法取得宿主实际依赖版本')
  process.exit(0)
}
const lockText = readFileSync(lockPath, 'utf8')

for (const entry of npmPlugins) {
  console.log(`\n  ── ${entry.name}  (${entry.npm}) ──`)

  const installed = join(root, 'bundle-runtime', 'plugins', entry.name, 'package.json')
  const cacheName = entry.name.replace(/[@/]/g, '_')
  const cached = join(
    process.env.CI ? join(root, '.plugin-cache') : join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'jds-plugin-cache'),
    cacheName,
    'package.json',
  )
  const pkgPath = existsSync(installed) ? installed : existsSync(cached) ? cached : null

  if (!pkgPath) {
    console.log('     ⏭️  未找到已解包的 package.json（先跑一次 node scripts/prepare-bundle.js）')
    continue
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    check(false, `${entry.name} 的 package.json 解析失败`, String(error.message))
    continue
  }

  const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/'))
  // 插件对上游第三方 provider SDK 的 peer（如 pi-ai）同样值得检查
  const thirdParty = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => !name.startsWith('@deepseek-ai/') && name.startsWith('@'))

  let checked = 0
  for (const [dep, range] of [...peers, ...thirdParty]) {
    const locked = lockedVersion(lockText, dep)
    if (!locked) continue // 宿主依赖树里没有这个包，跳过（可能是插件私有的可选依赖）
    checked += 1
    if (satisfies(locked, range)) {
      check(true, `${dep}: 宿主锁定 ${locked} 落在声明范围 ${range}`)
      continue
    }
    const accepted = ACCEPTED_PEER_DRIFT[`${entry.name}|${dep}`]
    if (accepted) {
      console.log(
        `  ℹ️  ${dep}: 宿主锁定 ${locked} 不落在声明范围 ${range} —— **已知且已接受**\n` +
          `       声明 ${accepted.declared} / 宿主 ${accepted.hostLocked}\n` +
          `       ${accepted.reason}`,
      )
      continue
    }
    check(
      false,
      `${dep}: 宿主锁定 ${locked} 不落在声明范围 ${range}`,
      `插件 ${pkg.name}@${pkg.version} 声明 "${range}"，但宿主 pnpm-lock 解析为 ${locked}。\n` +
        `       这是**声明与现实不符**：prepare-bundle 不校验 peer，构建不会报错，\n` +
        `       风险留到运行期。请确认插件用到的 API 在该版本上确实存在（把结论写进 plugins.manifest.yaml 的注释），\n` +
        `       或把它钉到声明范围与宿主一致的版本；确认无害后登记进本脚本的 ACCEPTED_PEER_DRIFT。`,
    )
  }

  if (checked === 0) {
    console.log('     ℹ️  声明的 peer 均未出现在宿主依赖树中，无可对比项')
  } else {
    console.log(`     ℹ️  已比对 ${checked} 条 peer 声明`)
  }
}

if (failures === 0) {
  console.log('\n🎉 所有 npm 插件的 peer 声明都与宿主锁定的版本一致')
  process.exit(0)
}
console.log(`\n⚠️ 有 ${failures} 条 peer 声明与宿主实际版本不符（多为「声明保守」而非真实损坏，请逐条确认后决定是否接受）`)
process.exit(1)
