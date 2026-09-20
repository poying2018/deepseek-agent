/**
 * 内核启动加速补丁的「输出恒等」校验（`pnpm check:kernelspeed`）。
 *
 * 为什么单独有这一道：@deepseek-ai/dsh-client-modules 那条补丁改的是内核每次启动
 * 都会跑的 combo / source-map 构建（2026-09-20 实测 --cpu-prof：占内核 web 启动
 * CPU 的 48.7%，启动 7.5s → 4.7s）。它的全部价值在于**输出逐字节不变** ——
 * 一旦不等价就不是性能优化，而是静默改动浏览器拿到的 client combo 与 sourceMappingURL。
 *
 * check:patches 只断言"补丁文本在位"，断言不了"改写仍等价"；本脚本三件事一起闭环：
 *   ① 补丁表里写的代码 === 本脚本内联比对的代码（防止两处各自演化造成假绿）；
 *   ② 真正会被打进 asar 的产物里就是这份代码；
 *   ③ 拿上游原实现作真值，对每个真实 bundle 断言换行数与 mappings 串完全相同。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 期望的代码片段（字面量 = 产物里应当出现的文本）────────────────────────────
const F_NC =
  '\tfor (let i = value.indexOf("\\n"); i !== -1; i = value.indexOf("\\n", i + 1)) count += 1;'
const F_MAP =
  '\tconst __ljanxLines = newlineCount(source);\n'
  + '\tconst mappings = __ljanxLines === 0 ? "" : "AAAA" + ";AACA".repeat(__ljanxLines - 1);'

// ── 上游原实现（照抄 lib/index.js，作为真值）─────────────────────────────────
function newlineCountUpstream(value) {
  let count = 0
  for (const char of value) if (char === '\n') count += 1
  return count
}
function mappingsUpstream(source) {
  return Array.from({ length: newlineCountUpstream(source) }, (_, i) => (i === 0 ? 'AAAA' : 'AACA')).join(';')
}
// ── 补丁实现（与 F_NC / F_MAP 同一份语义）───────────────────────────────────
function newlineCountPatched(value) {
  let count = 0
  for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) count += 1
  return count
}
function mappingsPatched(source) {
  const lines = newlineCountPatched(source)
  return lines === 0 ? '' : 'AAAA' + ';AACA'.repeat(lines - 1)
}

let checked = 0
let failures = 0
const warnings = []
const fail = (what, detail) => { failures += 1; console.log(`  ❌ ${what}${detail ? ' —— ' + detail : ''}`) }

console.log('▶ 断言 client-modules 补丁：写法对齐 + 输出恒等')

// ── ① 补丁表 ↔ 本脚本 ───────────────────────────────────────────────────────
const { PLUGIN_RUNTIME_PATCHES } = await import(pathToFileURL(join(root, 'src', 'main', 'plugin-compat.js')).href)
const entry = PLUGIN_RUNTIME_PATCHES.find((e) => e.plugin === '@deepseek-ai/dsh-client-modules')
if (!entry || entry.edits.length !== 2) {
  fail('补丁表条目', `应恰好 2 处，实际 ${entry ? entry.edits.length : '没有该条目'}`)
} else {
  const patchText = entry.edits.map((ed) => (ed.toLines ? ed.toLines.join('\n') : ed.to ?? '')).join('\n')
  checked += 1
  if (!patchText.includes(F_NC) || !patchText.includes(F_MAP)) {
    fail('补丁表与本脚本内联实现不是同一份代码', '等价性按本脚本判定、产物按补丁表写入，两者必须一致')
  }
}

// ── ② 产物 ↔ 补丁表 ─────────────────────────────────────────────────────────
const artifacts = [
  join(root, 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'),
  join(root, 'bundle-runtime', 'plugins', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'),
  join(root, 'bundle-runtime', 'app', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'),
].filter((p) => existsSync(p))
if (artifacts.length === 0) {
  warnings.push('本机没有 client-modules 产物可读（跳过 ②，由 check:patches 在暂存后覆盖）')
}
for (const file of artifacts) {
  // 产物行尾可能是 CRLF（补丁执行器按文件自身行尾拼接），比对统一按 LF 归一
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  checked += 1
  if (!text.includes(F_NC) || !text.includes(F_MAP)) {
    fail('产物与本脚本内联实现不一致', file)
  }
}

// ── ③ 语义恒等：边界 + 真实 bundle ──────────────────────────────────────────
for (const s of ['', '\n', '\n\n', 'a\nb', 'a\r\nb\r\n', 'no-newline', '\n'.repeat(5), '尾行无换行\nabc']) {
  checked += 1
  if (newlineCountUpstream(s) !== newlineCountPatched(s)) fail('边界换行数', JSON.stringify(s))
  else if (mappingsUpstream(s) !== mappingsPatched(s)) fail('边界 mappings 串', JSON.stringify(s))
}

const bundleFiles = []
for (const base of [join(root, 'bundle-runtime', 'plugins'), join(root, 'node_modules', '@deepseek-ai')]) {
  if (!existsSync(base)) continue
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    for (const cand of [join(base, e.name, 'client.js'), join(base, e.name, 'lib', 'client.js')]) {
      bundleFiles.push(cand)
    }
  }
}
let realCount = 0
let bigCount = 0
for (const file of bundleFiles) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  realCount += 1
  checked += 1
  const cu = newlineCountUpstream(text)
  const cp = newlineCountPatched(text)
  if (cu !== cp) { fail('换行数不一致', `${file}: ${cu} vs ${cp}`); continue }
  const mu = mappingsUpstream(text)
  const mp = mappingsPatched(text)
  if (mu !== mp) {
    const idx = [...mu].findIndex((c, i) => c !== mp[i])
    fail('mappings 串不一致', `${file}: 首个差异在第 ${idx} 字符（${mu.length} vs ${mp.length}）`)
    continue
  }
  if (text.length > 50_000) bigCount += 1
}
console.log(`  · 真实 bundle ${realCount} 个（其中 >50KB 的 ${bigCount} 个）逐字节比对`)

for (const w of warnings) console.log(`  ⚠️  ${w}`)
if (failures > 0) {
  console.log(`\n✗ ${failures} 处失败：这条补丁已不再是"纯性能改写"，必须改成等价写法或整条撤掉`)
  process.exit(1)
}
console.log(`\n✓ ${checked} 组断言通过 —— 补丁写法与产物一致，且输出逐字节等价于上游`)
