/**
 * 发行版「补丁组合」端到端验证（`npm run check:dist`）。
 *
 * 目的：把打包产物里**全部 bundle 的自带补丁**按 DSH 真实顺序，用官方
 * applyEntryPatches 组合成最终 entry 树，回答三个问题：
 *  1. 有没有任何一条补丁行被**静默跳过**（捕获 warn 回调，这是本类 bug 的指纹）；
 *  2. 目录选择器修复在「全量组合」下是否依然成立（auto 停用 + browse 两面生效）；
 *  3. 每个插件的 id / 插件名在整棵树里是否唯一（重复挂载会报错）。
 *
 * 为什么不能只跑 check:picker：check:picker 只看「profile 层 + 官方两层」，
 * 而真实发行版有 20+ 个第三方 bundle，每个都带着自己的 cordis.patch.yml。
 * 任意一个的补丁与别人撞 id、或与官方行撞 name，都只会在启动时留一条 warn。
 * 本脚本正是把「全量组合」这件事变成断言。
 *
 * 用法（在仓库根目录跑）：
 *   node scripts/verify-dist-compose.mjs [dshHome] [runtimePath] [候选插件,...]
 * 默认 dshHome 取 <userData>/dsh-data 之类难以猜到的位置，所以更推荐显式传参：
 *   node scripts/verify-dist-compose.mjs "$HOME/.jackdsh-data" release/win-unpacked/resources/runtime
 * 第 3 个参数可选，用于临时评估「把某插件补进 bundles 会不会撞 id」；
 * 不传时场景 B 会自动扫 runtime/plugins 找出孤儿插件（打进包却没注册的）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(join(process.cwd(), 'noop.js'))

const DEFAULT_RUNTIME = join(process.cwd(), 'release', 'win-unpacked', 'resources', 'runtime')

/** 依次尝试候选 dshHome，返回第一个存在 profiles/web/package.json 的 */
function findDshHome(explicit) {
  const candidates = [
    explicit,
    process.env.JDS_DSH_HOME,
    process.env.DSH_HOME,
    join(homedir(), 'AppData', 'Roaming', 'JackDSH', 'dsh-data'),
    join(homedir(), 'AppData', 'Roaming', 'jackdsh', 'dsh-data'),
  ].filter((v) => typeof v === 'string' && v.trim())
  for (const dir of candidates) {
    if (existsSync(join(dir, 'profiles', 'web', 'package.json'))) return dir
  }
  return null
}

// 参数解析：支持「只给 dshHome」「dshHome + runtimePath」「只给 runtimePath」
const argv2 = process.argv[2]
const argv3 = process.argv[3]
let dshHomeArg
let runtimePath
if (argv3) {
  dshHomeArg = argv2
  runtimePath = argv3
} else if (argv2) {
  // 单个参数：像 runtime 目录就当 runtimePath，否则当 dshHome
  if (/resources[\\/]runtime$|[\\/]runtime$/.test(argv2)) {
    runtimePath = argv2
  } else {
    dshHomeArg = argv2
    runtimePath = DEFAULT_RUNTIME
  }
} else {
  runtimePath = DEFAULT_RUNTIME
}

const homeExplicit = Boolean(dshHomeArg && dshHomeArg.trim())
const dshHome = findDshHome(dshHomeArg)
const profilePkgPath = dshHome ? join(dshHome, 'profiles', 'web', 'package.json') : null
const profilePatchPath = dshHome ? join(dshHome, 'profiles', 'web', 'cordis.patch.yml') : null

const AUTO = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSE_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSE_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `\n       ${extra}`}`)
  if (!ok) failures += 1
}

const includePath = require.resolve('@deepseek-ai/cordis-plugin-include')
const { applyEntryPatches, entryListSchema } = await import(pathToFileURL(includePath).href)
const { load } = await import('js-yaml')
const layerOf = (file) => load(readFileSync(file, 'utf8'), { schema: entryListSchema })

function patchOf(bundleName) {
  if (bundleName.startsWith('@deepseek-ai/')) {
    try {
      return require.resolve(`${bundleName}/cordis.patch.yml`)
    } catch {
      return null
    }
  }
  const p = join(runtimePath, 'plugins', ...bundleName.split('/'), 'cordis.patch.yml')
  return existsSync(p) ? p : null
}

function compose(bundleNames, label) {
  const warnings = []
  const layers = []
  const missing = []
  for (const name of bundleNames) {
    const file = patchOf(name)
    if (!file) {
      missing.push(name)
      continue
    }
    layers.push({ name, file })
  }
  // profile 层的 JackDSH 托管补丁永远是最后一层（DSH 里 profile 补丁优先级最高）
  if (profilePatchPath && existsSync(profilePatchPath)) {
    layers.push({ name: '<profile>/cordis.patch.yml', file: profilePatchPath })
  }
  let tree = []
  for (const layer of layers) {
    tree = applyEntryPatches(tree, layerOf(layer.file), (msg) => warnings.push(`[${layer.name}] ${msg}`))
  }
  return { tree, warnings, missing, layers, label }
}

function assert(label, result) {
  const { tree, warnings, missing } = result
  console.log(`\n${'─'.repeat(68)}\n${label}\n${'─'.repeat(68)}`)
  console.log(
    `  补丁层 ${result.layers.length} 个｜缺失 ${missing.length} 个｜warn ${warnings.length} 条｜最终条目 ${tree.length} 条`,
  )
  if (missing.length) console.log(`  缺失补丁：${missing.join(', ')}`)

  check(warnings.length === 0, '没有任何补丁行被静默跳过（warn 为空）', warnings.join('\n       '))

  const pickerRows = tree.filter((e) => /directory-picker/.test(String(e.name ?? '')))
  const active = pickerRows.filter((e) => !e.disabled)
  check(
    pickerRows.some((e) => e.name === AUTO && e.disabled === true),
    '官方 auto 选择器行已停用',
  )
  check(
    active.length === 2 && active.some((e) => e.name === BROWSE_BACKEND) && active.some((e) => e.name === BROWSE_SURFACE),
    '生效的选择器行恰好是 browse 的两面',
    `实际生效 ${active.length} 条：${active.map((e) => e.name).join(', ')}`,
  )

  const idCounts = new Map()
  for (const e of tree) {
    if (e.id === undefined) continue
    idCounts.set(e.id, (idCounts.get(e.id) ?? 0) + 1)
  }
  const dupIds = [...idCounts].filter(([, n]) => n > 1)
  check(dupIds.length === 0, '整棵 entry 树里没有重复 id', dupIds.map(([id, n]) => `${id} ×${n}`).join(', '))

  const nameCounts = new Map()
  for (const e of active) {
    if (e.name === undefined) continue
    nameCounts.set(e.name, (nameCounts.get(e.name) ?? 0) + 1)
  }
  const dupNames = [...nameCounts].filter(([, n]) => n > 1)
  check(dupNames.length === 0, '生效行里没有重复插件', dupNames.map(([n, c]) => `${n} ×${c}`).join(', '))

  return { tree, active }
}

// ── 场景 A：当前发行版的真实 bundle 清单 ──
if (!profilePkgPath) {
  console.error(
    '\n⚠️  找不到已初始化的 dshHome（需要其中的 profiles/web/package.json）。\n' +
      '   请显式传入，或先启动一次应用让它生成 profile：\n' +
      '     node scripts/verify-dist-compose.mjs "<dshHome>" [runtimePath]\n',
  )
  process.exit(2)
}
const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
const bundles = profilePkg.dsh.profile.bundles

console.log(`\ndshHome：${dshHome}${homeExplicit ? '' : '（未显式传参，自动探测到的本机活数据目录）'}`)
console.log(`runtimePath：${runtimePath}`)

// ── 数据新鲜度指纹 ──────────────────────────────────────────────────────
// 本脚本的被测对象是「profile 里那份 cordis.patch.yml」，而它由**应用启动时**
// 重写。如果你用的是本机活数据目录、且它最后一次启动早于当前构建，那么这份
// 补丁可能还是旧版本（例如目录选择器修复之前的形态），场景 A 会整片报红，
// 看上去像回归、实际只是文件陈旧。把「修改时间 + 有没有托管区标记」打出来，
// 一眼就能区分「真回归」与「读了旧文件」。
if (profilePatchPath && existsSync(profilePatchPath)) {
  const st = statSync(profilePatchPath)
  const patchRaw = readFileSync(profilePatchPath, 'utf8')
  const hasManaged = patchRaw.includes('# >>> JackDSH 托管区')
  const stamp = `${st.mtime.getFullYear()}-${String(st.mtime.getMonth() + 1).padStart(2, '0')}-${String(st.mtime.getDate()).padStart(2, '0')} ${String(st.mtime.getHours()).padStart(2, '0')}:${String(st.mtime.getMinutes()).padStart(2, '0')}`
  console.log(`profile 补丁：${profilePatchPath}`)
  console.log(`  最后修改 ${stamp}｜${st.size} 字节｜托管区标记 ${hasManaged ? '有' : '无 ★'}`)
  if (!hasManaged && !homeExplicit) {
    console.log(
      '  ⚠️  这份补丁没有托管区标记，说明它由**旧版本**写入。请用当前构建启动一次应用' +
        '（让它就地重写），或显式传入一个刚启动过的目录，否则下面的失败均为误报。',
    )
  }
}
console.log(`\n发行版真实 bundle 清单（${bundles.length} 个）：`)
bundles.forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${b}`))

const A = compose(bundles, 'A')
assert('场景 A — 当前发行版 bundle 清单 + profile 托管补丁', A)

// 新集成插件是否真的落地
const wb = A.tree.find((e) => e.name === 'dsh-connect-workbuddy' || e.id === 'dsh-connect-workbuddy')
check(Boolean(wb), 'dsh-connect-workbuddy 已进入最终 entry 树')
check(wb?.disabled !== true, 'dsh-connect-workbuddy 处于启用状态')
check(
  A.tree.filter((e) => e.name === 'dsh-connect-workbuddy').length === 1,
  'dsh-connect-workbuddy 只挂载一次（杜绝重复注册 provider）',
)

// ── 场景 B：孤儿插件探测（打进包却不在 bundles = 永不注册）──
//
// 候选来源：优先取第 3 个参数（逗号分隔的插件名，用于临时评估某个插件），
// 否则自动扫 runtime/plugins 找出「已暂存但未注册」的孤儿。
// 这个场景会长期有用：任何人往 plugins.manifest.yaml 加了插件却忘了加
// own-plugins.js，这里就会把它列出来并顺手验证「补进去会不会撞 id」。
const explicit = (process.argv[4] ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/** 扫 runtime/plugins，展开 scoped 包目录（@scope/name） */
function listStagedPlugins() {
  const root = join(runtimePath, 'plugins')
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(join(root, entry.name), { withFileTypes: true })) {
        if (sub.isDirectory()) out.push(`${entry.name}/${sub.name}`)
      }
    } else {
      out.push(entry.name)
    }
  }
  return out
}

const staged = listStagedPlugins()
const orphans = staged.filter((n) => !bundles.includes(n))
const candidates = explicit.length ? explicit : orphans

if (candidates.length === 0) {
  check(true, `没有孤儿插件（runtime/plugins 下 ${staged.length} 个插件全部已注册）`)
  console.log('       ℹ️  场景 B 跳过：没有「打进包却未注册」的插件可评估')
} else {
  const B = compose([...bundles, ...candidates], 'B')
  assert(`场景 B — 追加 ${candidates.join(' + ')}（评估「是否补进 bundles」）`, B)
  const dupB = []
  const seenB = new Map()
  for (const e of B.tree) if (e.id !== undefined) seenB.set(e.id, (seenB.get(e.id) ?? 0) + 1)
  for (const [id, n] of seenB) if (n > 1) dupB.push(`${id} ×${n}`)
  check(dupB.length === 0, '追加后仍无 id 冲突（说明可以安全补进 bundles）', dupB.join(', '))
  if (B.warnings.length === 0 && dupB.length === 0) {
    console.log(
      `       ℹ️  结论：可以把 ${candidates.join(', ')} 补进 own-plugins.js；` +
        `条目数 ${A.tree.length} → ${B.tree.length}（+${B.tree.length - A.tree.length}）`,
    )
  }
}

console.log(`\n${'='.repeat(68)}`)
if (failures === 0) {
  console.log('🎉 全量补丁组合验证通过：无静默跳过、选择器修复成立、无重复挂载')
  process.exit(0)
}
console.error(`⚠️  组合验证失败：${failures} 条断言未通过`)
process.exit(1)
