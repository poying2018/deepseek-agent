/**
 * 内核启动性能台（一次性投入，换"数字可复现"）。
 *
 * 为什么需要：v1.4.0 那条 client-modules 加速补丁的全部说服力都在一句
 * 「上游 7.3~7.6s → 补丁后 4.5~4.8s」上，而这个数**不能拿正在跑的 App 测**
 * （同一个 DSH_HOME 起第二个内核会并发写 workspace.json / projcache / 会话），
 * 也不能凭空换个空 DSH_HOME 测（插件是从 <DSH_HOME>/profiles 加载的，换个空的
 * 等于测了另一套负载）。所以这里把"造一份忠实副本 + 计时 + 采样"固化下来。
 *
 * 用法：
 *   node scripts/perf-kernel-boot.mjs clone            # 造/修副本（含符号链接修复）
 *   node scripts/perf-kernel-boot.mjs bench [n]        # 跑 n 次到 TCP ready，报中位数
 *   node scripts/perf-kernel-boot.mjs profile          # 采 .cpuprofile 并打印热点表
 *
 * 关键坑（都实测踩过）：
 *  · 副本不能用普通 cp/robocopy：`profiles/node_modules/**` 与
 *    `profiles/web/.dsh-module-fallback/node_modules/**` 是 dsh 管理的 module-proxy
 *    **符号链接**，被解引用成真实目录后内核 boot 自检直接抛
 *    "... exists and is not a symlink or dsh-managed module proxy"。clone 子命令会
 *    把这些链接按源目录逐一重建成 junction。
 *  · 源 dshHome 里的 attachments/ 有几百 MB 且与启动无关，跳过。
 *  · bin.js 顶层是 `if (import.meta.main) await runCli()`：被 import 时**什么都不做**，
 *    必须取导出手调 runCli()，而且不能 await（服务常驻不返回）。
 *  · SIGKILL 掉的进程不会落 .cpuprofile，所以 profile 模式必须自己 Profiler.stop 再写盘。
 *  · 内核进程会继承 ~/.npmrc 里的代理；本机 7897 那个代理是死的，不清掉会显著拖慢/挂住。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')
const SCRATCH = join(tmpdir(), 'jds-perf')
const DATA = join(SCRATCH, 'dsh-data')
const PORT = Number(process.env.PERF_PORT || 3199)
const KERNEL_VERSION_HINT = '0.1.5-rc.2'

function sourceDshHome() {
  // 已安装 DeepSeek Agent 的隔离数据目录（Roaming，不是 Local）
  return join(process.env.APPDATA, 'ljanx', 'dsh-data')
}
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const binScript = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// ── clone：复制 + 重建 module-proxy 链接 ─────────────────────────────────────
async function cmdClone() {
  const src = sourceDshHome()
  if (!existsSync(join(src, 'profiles', 'web', 'package.json'))) {
    console.error(`✗ 源 dshHome 不像样：${src}`)
    process.exit(1)
  }
  console.log(`▶ 复制 ${src} → ${DATA}（跳过 attachments）`)
  rmSync(DATA, { recursive: true, force: true })
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'attachments') continue
    cpSync(join(src, e.name), join(DATA, e.name), { recursive: true, dereference: false, force: true })
  }
  // 复制器会把 junction 指向的内容拷成真实目录 —— 按源逐一重建成链接。
  // 源里这些条目用 fs.readlinkSync 就能取到目标（实测 508 个全部命中、零失败）。
  let linked = 0, copied = 0
  const relink = (srcDir, dstDir) => {
    if (!existsSync(srcDir)) return
    mkdirSync(dstDir, { recursive: true })
    for (const name of readdirSync(srcDir)) {
      const s = join(srcDir, name)
      const d = join(dstDir, name)
      let target = null
      try { target = readlinkSync(s) } catch { target = null }
      if (target) {
        rmSync(d, { recursive: true, force: true })
        try { symlinkSync(target, d, 'junction'); linked += 1 } catch (e) { console.warn('  链接失败', d, e.code) }
        continue
      }
      if (statSync(s).isDirectory()) { copied += 1; relink(s, d) }
    }
  }
  relink(join(src, 'profiles', 'node_modules'), join(DATA, 'profiles', 'node_modules'))
  relink(join(src, 'profiles', 'web', '.dsh-module-fallback', 'node_modules'),
    join(DATA, 'profiles', 'web', '.dsh-module-fallback', 'node_modules'))
  console.log(`  重建 module-proxy 链接 ${linked} 个（另有 ${copied} 个普通子目录，如 scope 名）`)
  const probe = join(DATA, 'profiles', 'node_modules', '@deepseek-ai', 'dsh')
  if (!existsSync(probe)) {
    console.error('✗ 副本缺 profiles/node_modules/@deepseek-ai/dsh，内核 boot 自检会拒绝')
    process.exit(1)
  }
  console.log('✓ 副本就绪')
}

// ── 启动计时 ─────────────────────────────────────────────────────────────────
function bootEnv(extra = {}) {
  const cleared = { HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' }
  return {
    ...process.env,
    ...cleared,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: join(root, 'node_modules'),
    DSH_HOME: DATA,
    DSH_PORT: String(PORT),
    PORT: String(PORT),
    DSH_WORKSPACE: join(DATA, 'workspace'),
    DSH_DESKTOP_ISOLATED: '1',
    NODE_ENV: 'production',
    ...extra,
  }
}

function waitForPort(timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const attempt = () => {
      const sock = connect(PORT, '127.0.0.1')
      sock.on('connect', () => { sock.destroy(); resolve(true) })
      sock.on('error', () => sock.destroy())
      sock.on('close', () => { Date.now() - t0 > timeoutMs ? resolve(false) : setTimeout(attempt, 200) })
    }
    attempt()
  })
}

async function cmdBench(runs = 3) {
  if (!existsSync(join(DATA, 'profiles', 'web', 'package.json'))) {
    console.error('✗ 副本不存在，先跑：node scripts/perf-kernel-boot.mjs clone')
    process.exit(1)
  }
  const kernel = JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
  console.log(`▶ 计时 ${runs} 次（内核 ${kernel}${kernel === KERNEL_VERSION_HINT ? '，与当初采样的版本一致' : ' ⚠️ 与当初采样版本不同，数字别直接对比'}，判据 = 端口可连）`)
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now()
    const child = spawn(electronExe, ['--expose-internals', binScript, 'web', '--port', String(PORT), '--no-open'],
      { env: bootEnv(), cwd: DATA, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-1500) })
    const ok = await waitForPort(120000)
    const dt = (Date.now() - t0) / 1000
    child.kill()
    times.push(dt)
    console.log(`  ${ok ? 'READY' : 'TIMEOUT'}  #${i + 1}: ${dt.toFixed(1)}s`)
    if (!ok) console.log(err)
    await new Promise((r) => setTimeout(r, 1200))
  }
  const sorted = [...times].sort((a, b) => a - b)
  console.log(`\n中位数 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}s ／ 全部 ${times.map((t) => t.toFixed(1)).join(', ')}s`)
}

// ── profile：采一次并打印热点 ────────────────────────────────────────────────
async function cmdProfile() {
  const profDir = join(SCRATCH, 'prof')
  rmSync(profDir, { recursive: true, force: true })
  mkdirSync(profDir, { recursive: true })
  const target = join(profDir, 'kernel.cpuprofile')
  const wrapper = join(profDir, 'wrapper.mjs')
  writeFileSync(wrapper, `
import { Session } from 'node:inspector'
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'
const port = Number(process.env.PORT), out = process.env.PERF_PROF_OUT
const s = new Session(); s.connect()
const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, r) => (e ? rej(e) : res(r))))
await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 500 }); await post('Profiler.start')
const t0 = Date.now()
// bin.js 从 process.argv 取命令：不改这一行的话它会以「无参数」跑，直接报
// "error: --profile <name> is required"（实测踩过）。argv[0] 无意义，argv[1] 要放 bin.js 本身。
process.argv = [process.execPath, ${JSON.stringify(binScript)}, 'web', '--port', String(port), '--no-open']
const mod = await import(pathToFileURL(${JSON.stringify(binScript)}).href)
mod.runCli().catch((e) => console.error('[perf] runCli threw:', e && e.message))  // 别 await：服务常驻
await new Promise((resolve) => {
  const attempt = () => {
    const sock = connect(port, '127.0.0.1')
    sock.on('connect', () => { sock.destroy(); resolve() })
    sock.on('error', () => sock.destroy())
    sock.on('close', () => setTimeout(attempt, 200))
  }
  attempt()
})
const { profile } = await post('Profiler.stop')
writeFileSync(out, JSON.stringify(profile))
console.log('[perf] ready in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's -> ' + out)
process.exit(0)
`)
  const child = spawn(electronExe, ['--expose-internals', wrapper], {
    env: bootEnv({ PERF_PROF_OUT: target }), cwd: DATA, stdio: 'inherit',
  })
  const code = await new Promise((r) => child.on('exit', r))
  if (code !== 0 || !existsSync(target)) { console.error('✗ 采样失败'); process.exit(1) }
  reportProfile(target)
}

function reportProfile(file) {
  const prof = JSON.parse(readFileSync(file, 'utf8'))
  const byId = new Map(prof.nodes.map((n) => [n.id, n]))
  const self = new Map()
  let total = 0
  for (let i = 0; i < prof.samples.length; i++) {
    const dt = (prof.timeDeltas[i] || 0) / 1000
    total += dt
    self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + dt)
  }
  const pkgAgg = new Map(), fnAgg = new Map()
  for (const [id, ms] of self) {
    const cf = byId.get(id)?.callFrame
    if (!cf) continue
    const url = (cf.url || '').replace(/^file:\/\/\//, '').replace(/%E9%A1%B9%E7%9B%AE/g, '项目')
    const m = url.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
    const pkg = m ? m[1] : url.startsWith('node:') ? '(node 内置)' : '(其他/匿名)'
    pkgAgg.set(pkg, (pkgAgg.get(pkg) || 0) + ms)
    fnAgg.set(`${cf.functionName || '(anon)'} @ ${url.split('/').slice(-2).join('/')}:${cf.lineNumber}`,
      (fnAgg.get(`${cf.functionName || '(anon)'} @ ${url.split('/').slice(-2).join('/')}:${cf.lineNumber}`) || 0) + ms)
  }
  const show = (map, title) => {
    console.log(`\n=== ${title}（总采样 ${(total / 1000).toFixed(1)}s）===`)
    for (const [k, ms] of [...map].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`${String(ms.toFixed(0)).padStart(6)} ms ${(ms / total * 100).toFixed(1).padStart(5)}%  ${k}`)
    }
  }
  show(pkgAgg, '按包')
  show(fnAgg, '按函数 self time')
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'clone') await cmdClone()
else if (cmd === 'bench') await cmdBench(Number(arg || 3))
else if (cmd === 'profile') await cmdProfile()
else console.log('用法: node scripts/perf-kernel-boot.mjs <clone|bench [n]|profile>')
