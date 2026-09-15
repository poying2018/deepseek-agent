/**
 * 启动就绪判定的回归守门（`npm run check:startup`）。
 *
 * 为什么需要它：这里曾经用「固定 15s 等 token URL + 5s HTTP 探测」来判定失败，
 * 而**全新安装后的第一次启动**要额外付出「杀毒软件实时扫描刚写盘的 200MB+ 文件」
 * 的代价 —— 实测同一份产物首次启动可超过 20 秒才就绪（之后每次只要 2~3 秒）。
 * 结果就是：服务其实马上就会起来，用户却先看到「后台服务未能正常就绪」弹窗，
 * 而且主窗口干脆不创建。这条路径恰好是每个装完安装包的新用户必经的那一次。
 *
 * 现在判据是「只要子进程还活着就继续等」，真失败信号是子进程退出。
 * 本脚本把这个判据变成断言 —— 尤其是「慢但活着」必须被容忍这一条，
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

console.log('\n[1/4] 已捕获到带 token 的 URL 时 —— 直接算就绪，不探测')
{
  const m = makeManager({ alive: true, probeResults: [false] })
  const ready = await m.awaitCoreReady('http://127.0.0.1:3199', 'http://127.0.0.1:3199/?token=x')
  check(ready === true, '返回 true')
  check(m.__probeCalls() === 0, '没有多余的 HTTP 探测', `实际探测 ${m.__probeCalls()} 次`)
}

console.log('\n[2/4] 子进程活着但很慢（模拟装完首次启动被杀软扫描拖住）')
{
  // 25 次探测失败后才就绪。旧实现（15s 等 URL + 单次 5s 探测）在这种情形下会
  // 直接抛「服务就绪探测超时」，而服务其实马上就起来了。
  const slow = [...Array(25).fill(false), true]
  const m = makeManager({ alive: true, probeResults: slow })
  const ready = await m.awaitCoreReady('http://127.0.0.1:3199', null, 90000)
  check(ready === true, '慢启动最终被判为就绪（不再误报失败）')
  check(m.__probeCalls() === 26, '一直等到探测成功才返回', `实际探测 ${m.__probeCalls()} 次`)
}

console.log('\n[3/4] 子进程已退出 —— 这是真失败信号，必须快速失败')
{
  const m = makeManager({ alive: false, probeResults: [false] })
  const t0 = Date.now()
  const ready = await m.awaitCoreReady('http://127.0.0.1:3199', null, 90000)
  const spent = Date.now() - t0
  check(ready === false, '判定为未就绪')
  check(m.__probeCalls() === 1, '探测一次即放弃（不为死掉的核心空等）', `实际探测 ${m.__probeCalls()} 次`)
  check(spent < 1000, `耗时极短（${spent}ms）`)
}

console.log('\n[4/4] 子进程活着但始终探测不到 —— 受总预算约束，不能无限挂起')
{
  const m = makeManager({ alive: true, probeResults: [false] })
  const t0 = Date.now()
  const ready = await m.awaitCoreReady('http://127.0.0.1:3199', null, 0)
  const spent = Date.now() - t0
  check(ready === false, '判定为未就绪')
  check(m.__probeCalls() === 1, '预算耗尽即停止（不会无限循环）', `实际探测 ${m.__probeCalls()} 次`)
  check(spent < 1000, `预算为 0 时不额外等待（${spent}ms）`)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log('🎉 启动就绪判定检查通过：慢启动被容忍、真失败快速暴露、总预算受控')
  process.exit(0)
}
console.error(`⚠️  启动就绪判定检查失败：${failures} 条断言未通过`)
process.exit(1)
