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
const { ServerManager } = await import(pathToFileURL(join(root, 'src', 'main', 'server-manager.js')).href)
const { ALL_BUILTIN_PLUGINS } = await import(pathToFileURL(join(root, 'src', 'main', 'own-plugins.js')).href)

let failures = 0
let checked = 0
const ok = (cond, what) => { checked += 1; if (!cond) { failures += 1; console.log(`  ❌ ${what}`) } else console.log(`  ✅ ${what}`) }

function makeFixture({ bundles, deadLinks = [], realPkgs = [], runtimePlugins = [] }) {
  const home = mkdtempSync(join(tmpdir(), 'jds-prune-'))
  const dshHome = join(home, 'dsh-data')
  const web = join(dshHome, 'profiles', 'web')
  const nm = join(web, 'node_modules')
  const runtime = join(home, 'runtime')
  mkdirSync(join(nm, '@deepseek-ai'), { recursive: true })
  mkdirSync(join(runtime, 'plugins'), { recursive: true })
  writeFileSync(join(web, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
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

const oneBuiltin = ALL_BUILTIN_PLUGINS[0]

console.log('▶ 1. 内置插件被删除后（bundles 里还有、包已不存在）不得砖掉内核')
{
  const f = makeFixture({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-runaway-guard', 'totally-removed'],
    deadLinks: ['dsh-runaway-guard', 'totally-removed'],
    runtimePlugins: [oneBuiltin],
  })
  try { f.sm.initIsolatedProfile() } catch (e) { ok(false, `initIsolatedProfile 抛异常：${e.message}`) }
  const b = readBundles(f.web)
  ok(!b.includes('dsh-runaway-guard'), '指向已删包的行被剔除（dsh-runaway-guard）')
  ok(!b.includes('totally-removed'), '指向已删包的行被剔除（另一个已消失包名）')
  ok(!existsSync(join(f.nm, 'dsh-runaway-guard')), '死链本体也被 unlink，不留残余')
  ok(b.includes('@deepseek-ai/dsh-base') && b.includes('@deepseek-ai/dsh-web-app'), '两个核心行仍在')
  ok(b.filter((x) => x === '@deepseek-ai/dsh-base').length === 1, 'dsh-base 不重复')
  ok(b.includes(oneBuiltin), `现存内置插件（${oneBuiltin}）被补进 bundles`)
  rmSync(f.home, { recursive: true, force: true })
}

console.log('▶ 2. 用户在应用内自己装的插件绝不能被误删')
{
  const f = makeFixture({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'user-installed-thing'],
    realPkgs: ['user-installed-thing'],
    runtimePlugins: [],
  })
  f.sm.initIsolatedProfile()
  const b = readBundles(f.web)
  ok(b.includes('user-installed-thing'), '不在内置列表但包真实存在 → 保留')
  ok(existsSync(join(f.nm, 'user-installed-thing', 'package.json')), '用户插件目录没被动过')
  rmSync(f.home, { recursive: true, force: true })
}

console.log('▶ 3. 幂等与容错')
{
  const f = makeFixture({
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'gone-1', '@deepseek-ai/dsh-base'],
    deadLinks: ['gone-1'],
    runtimePlugins: [oneBuiltin],
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
  ok(existsSync(join(root, 'builtin-plugins')), 'builtin-plugins 目录在位')
}

console.log(`\n${failures === 0 ? '✅' : '❌'} profile 自愈清理 ${checked} 组断言${failures ? `，${failures} 处失败` : '全部通过'}`)
process.exit(failures ? 1 : 0)
