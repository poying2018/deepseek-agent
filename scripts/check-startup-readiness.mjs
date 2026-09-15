/**
 * 启动就绪判定的回归守门（`npm run check:startup`）。
 *
 * 为什么需要它：这里曾经用「固定 15s 等 token URL + 5s HTTP 探测」来判定失败，
 * 而**全新安装后的第一次启动**要额外付出「杀毒软件实时扫描刚写盘的 200MB+ 文件」
 * 的代价 —— 实测同一份产物首次启动可超过 20 秒才就绪（之后每次只要 2~3 秒）。
 * 结果就是：服务其实马上就会起来，用户却先看到「后台服务未能正常就绪」弹窗，
 * 而且主窗口干脆不创建。这条路径恰好是每个装完安装包的新用户必经的那一次。
 *
 * 同一个成因还有第二处（更隐蔽）：捕获带 token 的认证 URL 那段原本也是
 * **固定 15 秒硬上限**。超时就回退到不带 token 的地址，窗口加载后只显示
 *   dsh web authentication required; reopen the URL printed by dsh web
 * 且不自愈 —— 等于应用打不开。同一台机器实测：
 *   · 已安装 + 系统空闲（热启动）  →  2.40s 拿到 token
 *   · 全新安装后立刻启动（冷启动） → 39.75s 拿到 token（旧逻辑早已超时 → 白屏）
 * 所以两处判据是同一套：**只要子进程还活着就继续等**，真失败信号是子进程退出。
 *
 * 本脚本把这两套判据都变成断言 —— 尤其是「慢但活着必须被容忍」这一条，
 * 因为它在真机上难以稳定复现（要靠杀软冷扫描）。
 */
import { ServerManager } from '../src/main/server-manager.js'

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `\n       ${extra}`}`)
  if (!ok) failures += 1
}

/**
 * 造一个只关心就绪判定的 ServerManager：
 * 不 spawn 任何东西，只替换 waitForHttpReady 与 childProcess 存活状态。
 * @param {{alive: boolean, probeResults: boolean[]}} opts
 */
function makeManager({ alive, probeResults }) {
  const manager = new ServerManager({ port: 3199, appDataPath: null, runtimePath: 'unused' })
  manager.childProcess = alive ? { pid: 1 } : null
  manager.lastExitCode = alive ? null : 1

  let calls = 0
  manager.waitForHttpReady = async () => {
    const r = probeResults[Math.min(calls, probeResults.length - 1)]
    calls += 1
    return r
  }
  manager.__probeCalls = () => calls
  return manager
}

console.log('\n══ awaitCoreReady：HTTP 就绪 ══')

console.log('\n[1/8] 已捕获到带 token 的 URL 时 —— 直接算就绪，不探测')
{
  const m = makeManager({ alive: true, probeResults: [false] })
  const ready = await m.awaitCoreReady('http://127.0.0.1:3199', 'http://127.0.0.1:3199/?token=x')
  check(ready === true, '返回 true')
  check(m.__probeCalls() === 0, '没有多余的 HTTP 探测', `实际探测 ${m.__probeCalls()} 次`)
}

console.log('\n[2/8] 子进程活着但很慢（模拟装完首次启动被杀软扫描拖住）')
{
  // 25 次探测失败后才就绪。旧实现（15s 等 URL + 单次 5s 探测）在这种情形下会
  // 直接抛「服务就绪探测超时」，而服务其实马上就起来了。
  const slow = [...Array(25).fill(false), true]
  const m = makeManager({ alive: true, probeResults: slow })
  const ready = await m.awaitCoreReady('http://127.0.0.1:3199', null, 90000)
  check(ready === true, '慢启动最终被判为就绪（不再误报失败）')
  check(m.__probeCalls() === 26, '一直等到探测成功才返回', `实际探测 ${m.__probeCalls()} 次`)
}

console.log('\n[3/8] 子进程已退出 —— 这是真失败信号，必须快速失败')
{
  const m = makeManager({ alive: false, probeResults: [false] })
  const t0 = Date.now()
  const ready = await m.awaitCoreReady('http://127.0.0.1:3199', null, 90000)
  const spent = Date.now() - t0
  check(ready === false, '判定为未就绪')
  check(m.__probeCalls() === 1, '探测一次即放弃（不为死掉的核心空等）', `实际探测 ${m.__probeCalls()} 次`)
  check(spent < 1000, `耗时极短（${spent}ms）`)
}

console.log('\n[4/8] 子进程活着但始终探测不到 —— 受总预算约束，不能无限挂起')
{
  const m = makeManager({ alive: true, probeResults: [false] })
  const t0 = Date.now()
  const ready = await m.awaitCoreReady('http://127.0.0.1:3199', null, 0)
  const spent = Date.now() - t0
  check(ready === false, '判定为未就绪')
  check(m.__probeCalls() === 1, '预算耗尽即停止（不会无限循环）', `实际探测 ${m.__probeCalls()} 次`)
  check(spent < 1000, `预算为 0 时不额外等待（${spent}ms）`)
}

console.log('\n══ awaitAuthToken：带 token 的认证地址 ══')

console.log('\n[5/8] token 已就绪 —— 立即返回，不做无谓等待')
{
  const m = makeManager({ alive: true, probeResults: [] })
  m.authenticatedUrl = 'http://127.0.0.1:3199/?token=abc'
  const t0 = Date.now()
  const ok = await m.awaitAuthToken(90000)
  const spent = Date.now() - t0
  check(ok === true, '返回 true')
  check(spent < 500, `耗时极短（${spent}ms）`)
}

console.log('\n[6/8] token 姗姗来迟但子进程一直活着 —— 必须容忍（对应真机 39.75s 冷启动）')
{
  // 真机上这个迟到是 39.75s；单测里缩短成 1.2s，语义完全一致：
  // 旧的固定 15s 硬上限在真机上会先超时 → 回退到无 token 地址 → 窗口白屏。
  const m = makeManager({ alive: true, probeResults: [] })
  const delayMs = 1200
  setTimeout(() => {
    m.authenticatedUrl = 'http://127.0.0.1:3199/?token=late'
  }, delayMs)
  const t0 = Date.now()
  const ok = await m.awaitAuthToken(90000)
  const spent = Date.now() - t0
  check(ok === true, '迟到但活着 ⇒ 仍被判为捕获成功（不再回退到无 token 地址）')
  check(spent >= delayMs, `确实等到了 token 出现之后（${spent}ms ≥ ${delayMs}ms）`)
  check(m.authenticatedUrl.includes('token=late'), '最终用的是带 token 的地址')
}

console.log('\n[7/8] 子进程已退出且始终没有 token —— 快速返回，不空等预算')
{
  const m = makeManager({ alive: false, probeResults: [] })
  const t0 = Date.now()
  const ok = await m.awaitAuthToken(90000)
  const spent = Date.now() - t0
  check(ok === false, '判定为未捕获到')
  check(spent < 1000, `耗时极短（${spent}ms）`)
}

console.log('\n[8/8] 子进程活着但始终没有 token —— 受总预算约束')
{
  const m = makeManager({ alive: true, probeResults: [] })
  const t0 = Date.now()
  const ok = await m.awaitAuthToken(0)
  const spent = Date.now() - t0
  check(ok === false, '判定为未捕获到')
  check(spent < 1000, `预算为 0 时不额外等待（${spent}ms）`)
}

console.log('\n' + '='.repeat(64))
if (failures === 0) {
  console.log('🎉 启动判定检查通过：慢启动被容忍、真失败快速暴露、总预算受控')
  process.exit(0)
}
console.error(`⚠️  启动判定检查失败：${failures} 条断言未通过`)
process.exit(1)
