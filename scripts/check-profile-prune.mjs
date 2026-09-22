/**
 * profile bundles 自愈清理的回归检查（`pnpm check:profile`）。
 *
 * 为什么需要：宿主靠 `profiles/web/package.json` 的 `dsh.profile.bundles` 告诉内核
 * 加载哪些插件，而**任一 loader entry 解析失败会中止整个 web 壳启动**（黑屏）。
 * 发行版每次增删内置插件，老用户 profile 里都会留下指向已消失包名的行 ——
 * 全靠 ServerManager.initIsolatedProfile() 那段自愈清理兜住。
 * 这个门禁就是钉住那段兜底：删插件不会砖掉任何人的 App，同时**不能误删**
 * 用户在应用内自己装的插件。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { ServerManager, KERNEL_CAPABILITIES } = await import(pathToFileURL(join(root, 'src', 'main', 'server-manager.js')).href)
const { ALL_BUILTIN_PLUGINS } = await import(pathToFileURL(join(root, 'src', 'main', 'own-plugins.js')).href)

let failures = 0
let checked = 0
const ok = (cond, what) => { checked += 1; if (!cond) { failures += 1; console.log(`  ❌ ${what}`) } else console.log(`  ✅ ${what}`) }

function makeFixture({ bundles, deadLinks = [], realPkgs = [], runtimePlugins = [], deps = [] }) {
  const home = mkdtempSync(join(tmpdir(), 'jds-prune-'))
  const dshHome = join(home, 'dsh-data')
  const web = join(dshHome, 'profiles', 'web')
  const nm = join(web, 'node_modules')
  const runtime = join(home, 'runtime')
  mkdirSync(join(nm, '@deepseek-ai'), { recursive: true })
  mkdirSync(join(runtime, 'plugins'), { recursive: true })
  writeFileSync(join(web, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: Object.fromEntries(deps.map((d) => [d, '1.0.0'])),
    dsh: { profile: { bundles } },
  }, null, 2))
  // 死链：指向一个不存在的目录（升级后被删掉的内置插件就是这个形态）
  for (const name of deadLinks) {
    const target = join(runtime, 'plugins', `${name}.__gone__`)
    mkdirSync(join(home, 'placeholder'), { recursive: true })
    try { symlinkSync(target, join(nm, name), 'junction') } catch { /* 无权限时退化为不存在，效果一样 */ }
  }
  // 用户自行安装的插件：真实目录 + package.json
  for (const name of realPkgs) {
    mkdirSync(join(nm, name), { recursive: true })
    writeFileSync(join(nm, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
  }
  // 本次发行里确实存在的内置插件（宿主会为它们建解析链接）
  for (const name of runtimePlugins) {
    mkdirSync(join(runtime, 'plugins', name), { recursive: true })
    writeFileSync(join(runtime, 'plugins', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
  }
  const sm = Object.create(ServerManager.prototype)
  sm.dshHome = dshHome
  sm.runtimePath = runtime
  return { home, dshHome, web, nm, runtime, sm }
}
const readBundles = (web) => JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')).dsh.profile.bundles

const hasBuiltins = ALL_BUILTIN_PLUGINS.length > 0
const oneBuiltin = ALL_BUILTIN_PLUGINS[0]

console.log('▶ 0. 本分支的不变量：不装任何插件')
if (hasBuiltins) {
  ok(ALL_BUILTIN_PLUGINS.length === 0, `内置插件清单应为空（实际 ${ALL_BUILTIN_PLUGINS.length} 个：${ALL_BUILTIN_PLUGINS.join(', ')}）`)
} else {
  ok(true, 'OWN/COMMUNITY/OPT_IN 三张清单都为空 —— 纯净版不变量成立')
}
{
  const manifest = readFileSync(join(root, 'plugins.manifest.yaml'), 'utf8')
  const declared = [...manifest.matchAll(/^\s*-\s+name:\s+(\S+)/gm)].map((m) => m[1])
  ok(declared.length === 0, `plugins.manifest.yaml 未声明任何外部插件（实际 ${declared.length} 个）`)
}

console.log('▶ 1. 内置插件被删除后（bundles 里还有、包已不存在）不得砖掉内核')
{
  const f = makeFixture({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-runaway-guard', 'totally-removed'],
    deadLinks: ['dsh-runaway-guard', 'totally-removed'],
    runtimePlugins: hasBuiltins ? [oneBuiltin] : [],
  })
  try { f.sm.initIsolatedProfile() } catch (e) { ok(false, `initIsolatedProfile 抛异常：${e.message}`) }
  const b = readBundles(f.web)
  ok(!b.includes('dsh-runaway-guard'), '指向已删包的行被剔除（dsh-runaway-guard）')
  ok(!b.includes('totally-removed'), '指向已删包的行被剔除（另一个已消失包名）')
  ok(!existsSync(join(f.nm, 'dsh-runaway-guard')), '死链本体也被 unlink，不留残余')
  ok(b.includes('@deepseek-ai/dsh-base') && b.includes('@deepseek-ai/dsh-web-app'), '两个核心行仍在')
  ok(b.filter((x) => x === '@deepseek-ai/dsh-base').length === 1, 'dsh-base 不重复')
  if (hasBuiltins) ok(b.includes(oneBuiltin), `现存内置插件（${oneBuiltin}）被补进 bundles`)
  else ok(b.length === 2, `内置清单为空时不凭空补任何行（bundles 只剩核心两行，实际 ${b.length} 行）`)
  rmSync(f.home, { recursive: true, force: true })
}

console.log('▶ 2. 用户在应用内自己装的插件绝不能被误删')
{
  const f = makeFixture({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'user-installed-thing'],
    realPkgs: ['user-installed-thing'],
    deps: ['user-installed-thing'],
    runtimePlugins: [],
  })
  f.sm.initIsolatedProfile()
  const b = readBundles(f.web)
  ok(b.includes('user-installed-thing'), '记在 dependencies 且真的装着 → 保留（连 deps 声明一起走）')
  ok(existsSync(join(f.nm, 'user-installed-thing', 'package.json')), '用户插件目录没被动过')
  rmSync(f.home, { recursive: true, force: true })
}

console.log('▶ 2b. dependencies 里声明了、但包其实不在 —— 必须剔除（留着内核整体起不来）')
{
  // 纯净版的副本实验真撞出来过一次：内核抛
  //   cannot resolve profile bundle "@ace-zone/dsh-market" …
  // 然后中止整个 web 壳。只凭 dependencies 保留就是一颗定时黑屏。
  const f = makeFixture({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@ghost/not-installed'],
    deps: ['@ghost/not-installed'],
    runtimePlugins: [],
  })
  f.sm.initIsolatedProfile()
  const b = readBundles(f.web)
  ok(!b.includes('@ghost/not-installed'), '声明未安装的包不得留在 bundles 里')
  ok(b.includes('@deepseek-ai/dsh-base') && b.includes('@deepseek-ai/dsh-web-app'), '两行核心行照常保留')
  const still = JSON.parse(readFileSync(join(f.web, 'package.json'), 'utf8')).dependencies || {}
  ok('@ghost/not-installed' in still, '只剔 bundles 行，不动 dependencies 声明（那是安装意图，归插件面板管）')
  rmSync(f.home, { recursive: true, force: true })
}

console.log('▶ 3. 幂等与容错')
{
  const f = makeFixture({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'gone-1', '@deepseek-ai/dsh-base'],
    deadLinks: ['gone-1'],
    runtimePlugins: hasBuiltins ? [oneBuiltin] : [],
  })
  f.sm.initIsolatedProfile()
  const first = JSON.stringify(readBundles(f.web))
  f.sm.initIsolatedProfile()
  const second = JSON.stringify(readBundles(f.web))
  ok(first === second, '连跑两次结果一致（幂等，不会每启动一次漂一点）')
  ok(JSON.parse(first).filter((x) => x === '@deepseek-ai/dsh-base').length === 1, '重复的核心行被收敛成一条')
  rmSync(f.home, { recursive: true, force: true })

  const empty = makeFixture({ bundles: [], runtimePlugins: [] })
  rmSync(join(empty.web, 'package.json'))
  let threw = null
  try { empty.sm.initIsolatedProfile() } catch (e) { threw = e }
  ok(!threw, `profile package.json 缺失也不抛（${threw ? threw.message : '正常'}）`)
  const b2 = readBundles(empty.web)
  ok(b2.includes('@deepseek-ai/dsh-base') && b2.includes('@deepseek-ai/dsh-web-app'), '冷启动下仍补齐两个核心行')
  rmSync(empty.home, { recursive: true, force: true })
}

console.log('▶ 4. 发行清单自检：不该再有已删除插件的残留注册')
{
  const leftovers = ['dsh-runaway-guard'].filter((n) => ALL_BUILTIN_PLUGINS.includes(n))
  ok(leftovers.length === 0, `OWN_PLUGINS 里已无历史插件残留（残留：${leftovers.join(',') || '无'}）`)
  const hasBuiltinDir = existsSync(join(root, 'builtin-plugins'));
  ok(ALL_BUILTIN_PLUGINS.length > 0 ? hasBuiltinDir : !hasBuiltinDir,
    ALL_BUILTIN_PLUGINS.length > 0 ? 'builtin-plugins 目录在位' : '内置清单为空时，仓内插件目录也应不存在（防止留下无人引用的源码）')
}

console.log('▶ 5. 内核自带能力：走 cordis.patch.yml 托管区，绝不进 bundles')
{
  // 放进 bundles 会让内核直接起不来（实测：`declares no dsh.bundle` 中止 web 壳启动），
  // 所以这里同时断言"patch 行有"与"bundles 行无"。
  const f = makeFixture({ bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], runtimePlugins: [] })
  f.sm.initIsolatedProfile()
  const patch = readFileSync(join(f.web, 'cordis.patch.yml'), 'utf8')
  const b = readBundles(f.web)
  const wantsReminder = KERNEL_CAPABILITIES.some((c) => c.pkg === '@deepseek-ai/dsh-repeat-tool-reminder');
  if (wantsReminder) ok(patch.includes("name: '@deepseek-ai/dsh-repeat-tool-reminder'"), '托管区里有反打转提示的 insert 行');
  else ok(!patch.includes('dsh-repeat-tool-reminder'), '本分支刻意不声明该能力 → 托管区里也不应出现这行');
  ok(!b.includes('@deepseek-ai/dsh-repeat-tool-reminder'), '它绝不进 bundles（进了会黑屏：未声明 dsh.bundle）')
  f.sm.initIsolatedProfile()
  const patch2 = readFileSync(join(f.web, 'cordis.patch.yml'), 'utf8')
  ok((patch2.match(/dsh-repeat-tool-reminder/g) || []).length === (patch.match(/dsh-repeat-tool-reminder/g) || []).length,
    '连跑两次托管区不重复追加')
  rmSync(f.home, { recursive: true, force: true })

  // 包解析不到（内核升版删了它）→ 整行不写，而不是留一条起不来的配置
  const g = makeFixture({ bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], runtimePlugins: [] })
  g.sm.readPackageJson = () => null
  g.sm.initIsolatedProfile()
  const patchG = readFileSync(join(g.web, 'cordis.patch.yml'), 'utf8')
  ok(!patchG.includes('dsh-repeat-tool-reminder'), '解析不到时不写这条能力行（宁可少个能力，不可砖掉启动）')
  rmSync(g.home, { recursive: true, force: true })
}

console.log('▶ 6. bundles 里「未声明 dsh.bundle」的内核行必须被剔除（那是必炸形态）')
{
  // @deepseek-ai/dsh-web 在仓库里确实没有 dsh.bundle —— 拿真实包做样本，
  // 一旦有人把它写进 bundles，内核会中止启动；自愈必须在启动前就把这行去掉。
  const f = makeFixture({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-web'],
    runtimePlugins: [],
  })
  const pkg = JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-web', 'package.json'), 'utf8'))
  ok(pkg.dsh?.bundle === undefined, '前置条件：@deepseek-ai/dsh-web 确实没声明 dsh.bundle')
  f.sm.initIsolatedProfile()
  const b = readBundles(f.web)
  ok(!b.includes('@deepseek-ai/dsh-web'), '这类行被自动剔除，而不是留着让内核崩')
  ok(b.includes('@deepseek-ai/dsh-base') && b.includes('@deepseek-ai/dsh-web-app'), '合规的两个核心行不动')
  rmSync(f.home, { recursive: true, force: true })

  // 但"读不到 package.json"不等于"坏行"：profile 的解析链接是内核启动时才修的，
  // 此刻读不到就剔除会误删核心能力 ⇒ 必须保留。
  const g = makeFixture({ bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], runtimePlugins: [] })
  g.sm.readPackageJson = (name) => (name === '@deepseek-ai/dsh-base' ? null : undefined)
  g.sm.initIsolatedProfile()
  const b2 = readBundles(g.web)
  ok(b2.includes('@deepseek-ai/dsh-base'), '读不到 package.json 时保守保留（不误删）')
  rmSync(g.home, { recursive: true, force: true })
}

console.log('▶ 7. 上游 reminder 的契约：只加提示，绝不结束回合')
{
  // 我们把它挂上发行版，就等于向用户承诺"它不会打断任务"（这正是撤掉自研看门狗的理由）。
  // 所以直接对着上游包做契约断言：命中阈值时只往 additionalContexts 前面塞一条提示，
  // 回合结局必须与 next() 一致；它自己永远不许产出 block/reject 之类的终止信号。
  const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-repeat-tool-reminder', 'lib', 'index.js')
  if (!existsSync(pkgDir)) {
    console.log('  ⏭️ 上游包不在本机，跳过契约断言')
  } else {
    const { apply } = await import(pathToFileURL(pkgDir).href)
    const listeners = []
    apply({ logger: { info() {}, warn() {}, error() {} }, on: (n, h) => listeners.push([n, h]) },
      { thresholds: [3, 5, 8], include: [], exclude: [], argumentsPreviewChars: 500 })
    const post = listeners.find(([n]) => n === 'tools/post-execute')?.[1]
    ok(Boolean(post), '它确实注册了 tools/post-execute（不是 pre-step 那种能掐轮的口子）')
    const agent = { id: 'a' }
    const exec = { agent, name: 'bash', arguments: '{"command":"ls -la"}' }
    const nextPass = async () => ({ kind: 'pass', additionalContexts: [] })
    const r1 = await post(exec, {}, nextPass)
    const r2 = await post(exec, {}, nextPass)
    ok((r1.additionalContexts || []).length === 0 && (r2.additionalContexts || []).length === 0,
      '连重 1、2 次：不注入任何东西')
    const r3 = await post(exec, {}, nextPass)
    const added = r3.additionalContexts || []
    ok(added.length === 1 && /repeating the exact same tool call/.test(added[0]?.content?.[0]?.text ?? ''),
      '连重 3 次：注入一条"你在重复完全相同的调用"提示')
    ok(added[0]?.source?.form === 'notice', '提示走 notice 形态（不会画成用户气泡）')
    ok(r3.kind === 'pass', '回合结局仍是 next() 的 pass —— 它无权结束回合')
    const blocked = await post(exec, {}, async () => ({ kind: 'block', feedback: 'x', additionalContexts: [] }))
    ok(blocked.kind === 'block' && blocked.feedback === 'x', '别人给的 block 原样透传，不篡改也不新增终止语义')
  }
}

console.log(`\n${failures === 0 ? '✅' : '❌'} profile 自愈清理 ${checked} 组断言${failures ? `，${failures} 处失败` : '全部通过'}`)
process.exit(failures ? 1 : 0)
