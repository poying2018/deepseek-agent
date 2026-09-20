/**
 * 兼容补丁表的落地门禁（`pnpm check:patches`）。
 *
 * 为什么需要它：src/main/plugin-compat.js 的补丁是**字符串锚点**，上游一重构锚点就飘，
 * 而飘了的后果是"静默空转"——构建日志里一行 ⚠️，产物照常出、功能照常坏。这已经真实
 * 咬过两次：
 *   · dsh-codearts-auth 的「只开一个登录浏览器」：上游把阻塞式 login() 换成 startLogin()
 *     又换回 login()，补丁来回失效两次（双浏览器 → CodeArts 卡在等待授权）；
 *   · @mlgbnb/dsh-archive-manager：会话日志改名成 session.v3.jsonl.zstd 后，插件把自己的
 *     误判写回 workspace.json，静默删掉用户的归档状态。
 * 所以这里不重新执行补丁，只对着**已经暂存/安装的产物**逐条断言：每一处 to 文本必须在位。
 * 不在位就是"这个修复没进包"，直接失败。
 *
 * 判据的取舍：以 to 文本为准而不是"from 是否还在"。因为上游可能把同一件事用另一种写法
 * 原生修好——那时 to 不在、from 也不在，本门禁会报错，逼人去看一眼再删掉这条补丁，
 * 而不是让它悄悄变成一条永不生效的死锚。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_RUNTIME_PATCHES } from '../src/main/plugin-compat.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 严格模式：发版时用（preflight 传 --release-strict）────────────────────────
// 为什么需要：本地默认 `pnpm prepare-bundle` 是 --source auto，**优先用 ../plugins 下的
// 开发克隆**；CI 则是 --source public，按清单 clone 固定 ref。两边暂存的字节可以完全不同，
// 于是"本地全绿、CI 未命中"是结构性的可能 —— v1.4.0 就真的这样：codearts 那条补丁在本地
// 暂存上命中、check:patches 绿，而 CI 日志里它是 ⚠️ 未命中（上游已换实现）。
// 判据来自 prepare-bundle 落盘的 bundle-runtime/staging-provenance.json。
// 注意 in-repo（仓内第一方插件，随仓库提交）与 npm@x（同版本号取同一份 tarball）都算发行输入，
// 只有 local@<sha>（开发克隆）不是。
const STRICT = process.argv.includes('--release-strict')
let provenance = null
try {
  provenance = JSON.parse(readFileSync(join(root, 'bundle-runtime', 'staging-provenance.json'), 'utf8'))
} catch {
  provenance = null
}
const patchedNames = [...new Set(PLUGIN_RUNTIME_PATCHES.map((e) => e.plugin))]
const devClonePatched = provenance
  ? patchedNames.filter((n) => String(provenance.plugins?.[n] ?? '').startsWith('local@'))
  : []

/** 同一个插件的产物可能在这三处之一：暂存区、仓库依赖、已安装 App 的 profile。 */
const CANDIDATE_ROOTS = [
  join(root, 'bundle-runtime', 'plugins'),
  join(root, 'node_modules'),
  process.env.DSH_PROFILE_MODULES || '',
].filter(Boolean)

let failures = 0
let checked = 0
let skipped = 0
const missing = []

const norm = (s) => s.replace(/\r\n/g, '\n')

console.log('▶ 逐条断言补丁已落地（共 ' + PLUGIN_RUNTIME_PATCHES.length + ' 条 / '
  + PLUGIN_RUNTIME_PATCHES.reduce((n, e) => n + e.edits.length, 0) + ' 处）')

for (const entry of PLUGIN_RUNTIME_PATCHES) {
  const base = CANDIDATE_ROOTS.map((r) => join(r, ...entry.plugin.split('/'))).find((p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  })
  if (!base) {
    console.log(`  ⏭️  ${entry.plugin}：产物不在本机（未暂存/未安装），跳过 ${entry.edits.length} 处`)
    skipped += entry.edits.length
    continue
  }
  for (const edit of entry.edits) {
    const file = join(base, edit.file)
    const to = norm(edit.toLines ? edit.toLines.join('\n') : edit.to ?? '')
    const from = norm(edit.fromLines ? edit.fromLines.join('\n') : edit.from ?? '')
    if (!existsSync(file)) {
      console.log(`  ❌ ${entry.plugin}/${edit.file}：补丁目标文件不存在`)
      failures += 1
      missing.push(`${entry.plugin}/${edit.file}（文件缺失）`)
      continue
    }
    const text = norm(readFileSync(file, 'utf8'))
    // 删除式补丁（to 为空）反过来断言：from 必须已经不在。
    const ok = to === '' ? !text.includes(from) : text.includes(to)
    checked += 1
    if (!ok) {
      console.log(`  ❌ ${entry.plugin}/${edit.file}`)
      console.log(`        补丁未落地：${JSON.stringify(to.slice(0, 72) || from.slice(0, 72))}…`)
      console.log(`        成因（${entry.desc}）—— 上游结构大概又变了，重新锚定或删掉这条。`)
      failures += 1
      missing.push(`${entry.plugin}/${edit.file}`)
    }
  }
  const landed = entry.edits.length
  console.log(`  ✅ ${entry.plugin}：${landed} 处全部在位 —— ${entry.desc}`)
}

// ── 来源核验：落地结论只对"这一份暂存"成立 ──────────────────────────────────
if (!provenance) {
  console.log('  ⚠️ 没有 bundle-runtime/staging-provenance.json —— 暂存出自旧版 prepare-bundle 或手工拼的，')
  console.log('     无法判断上面这些断言验的是不是发行输入（重跑 pnpm prepare-bundle 即生成）')
  if (STRICT) {
    console.error('△ 严格模式：本机暂存无法认定为发行输入（退出码 3）。CI 里 prepare-bundle 走 --source public，')
    console.error('   同一条门禁会真正把关；本机若在断网/代理不可用的环境下造不出发行输入，这是预期结果。')
    process.exit(3)
  }
} else if (devClonePatched.length > 0) {
  console.log(`  ⚠️ ${devClonePatched.length} 个带补丁的插件是从本地开发克隆暂存的：${devClonePatched.join(', ')}`)
  console.log('     它们的"已落地"只对开发克隆那一份字节成立，CI 按清单 ref 取到的可能是另一份。')
  if (STRICT) {
    console.error('△ 严格模式：本机暂存含开发克隆，不算发行输入（退出码 3）—— 由 CI 的同一条门禁把关。')
    process.exit(3)
  }
} else {
  console.log(`  ✅ 带补丁的插件全部来自发行输入（prepare-bundle --source ${provenance.source}）`)
}

console.log(`\n断言 ${checked} 处，跳过 ${skipped} 处（产物不在本机）`)
if (failures > 0) {
  console.error(`❌ ${failures} 处补丁没有落地：\n   - ${missing.join('\n   - ')}`)
  process.exit(1)
}
console.log('✅ 兼容补丁表全部落地')
