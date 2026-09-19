/**
 * dsh-runaway-guard 的决策回归检查（`pnpm check:guard`）。
 *
 * 为什么需要它：看门狗的价值全在阈值判断上，而它挂在 agent/pre-step 这道
 * waterfall 上——判错了要么「失控轮照样烧千万 token」，要么「正常任务被半路掐死」。
 * 两种失败都不会有人当场发现，所以把「给定步数/重复次数 → 放行 / 注入收尾 / 关轮」
 * 变成断言，而不是靠起一次真 App 手动等它转圈。
 *
 * 事件流按真实会话日志的形状伪造（assistant/message 带 tool-call → tool/call →
 * 下一步…），因为「本轮最后一次模型输出有没有再点工具」正是看门狗判断要不要插手
 * 的依据——这一条是实机跑出来的：真机第一版拿 pre-step 的 messages.length 当信号，
 * 而工具轮里那个数组本来就是空的，劝退一次都没发出去。
 *
 * 这里用假 ctx / 假 agent / 假 session 事件流跑真实插件代码（import 的就是发行版
 * 打进包的那份 index.js），不依赖内核是否在线。
 */
import { apply } from '../builtin-plugins/dsh-runaway-guard/index.js'

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `\n       ${extra}`}`)
  if (!ok) failures += 1
}

/** 一条 tool/call 会话事件。 */
const call = (turn, name, args) => ({ type: 'tool/call', data: { turn, step: 0, name, arguments: args } })
/** 一条 assistant/message：withCall=false 表示模型这一句没再点工具（本轮要收口了）。 */
const asst = (turn, withCall = true) => ({
  type: 'assistant/message',
  data: {
    turn,
    step: 0,
    message: {
      role: 'assistant',
      content: withCall
        ? [{ type: 'tool-call', toolCallId: `c${turn}`, toolName: 'bash', arguments: '{}' }]
        : [{ type: 'text', text: '结论如下。' }],
    },
  },
})
const userBubble = (kind = 'plugin') => ({ role: 'user', content: [], source: { kind } })

/** n 步的正常推进：每步一次模型输出 + 一条互不相同的工具调用。 */
const steps = (turn, n, argsOf = (i) => `echo ${i}`) => {
  const out = []
  for (let i = 1; i <= n; i += 1) out.push(asst(turn), call(turn, 'bash', argsOf(i)))
  return out
}
/** n 步原地打转：每步都是同一条工具调用。 */
const spinning = (turn, n) => steps(turn, n, () => 'ls -la')

/**
 * 装一次守卫，返回 step(turn, n, messages) 模拟第 n 步的 pre-step 请求。
 * @param config - 传给 apply 的配置
 * @param events - session.ownEvents() 的返回值
 */
function harness(config, events = []) {
  const logs = []
  const listeners = []
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
      debug: (m) => logs.push(['debug', String(m)]),
    },
    on: (name, handler) => {
      listeners.push([name, handler])
      return () => {}
    },
  }
  apply(ctx, config)
  const handler = listeners.find(([name]) => name === 'agent/pre-step')?.[1]
  const agent = { id: 'session-test', session: { ownEvents: () => events }, options: {} }
  const step = (turn, stepNumber, messages = [userBubble()]) => handler(
    { agent, turn, step: stepNumber, messages, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages }),
  )
  return { logs, handler, agent, step }
}

for (const key of [
  'DSH_RUNAWAY_GUARD',
  'DSH_RUNAWAY_GUARD_MAX_STEPS',
  'DSH_RUNAWAY_GUARD_GRACE_STEPS',
  'DSH_RUNAWAY_GUARD_REPEAT_LIMIT',
  'DSH_RUNAWAY_GUARD_REPEAT_HARD',
]) delete process.env[key]

const CFG = { maxSteps: 25, graceSteps: 4, repeatLimit: 3, repeatHard: 5 }

console.log('▶ 1. 默认阈值下的逐级反应（工具轮，每步调用各不相同）')
{
  const { logs, step } = harness(CFG, steps(1, 24))
  check(logs.some(([l, m]) => l === 'info' && /armed/.test(m)), '装载并打了 armed 日志')

  check((await step(1, 3)).messages.length === 1, '第 3 步照常放行')
  check((await step(1, 24)).messages.length === 1, '第 24 步（阈值前一步）不放水也不误杀')

  const soft = await step(1, 25)
  const note = soft.messages?.[1]
  check(soft.kind === 'enter' && soft.messages.length === 2, '第 25 步触发软阈值：追加一条消息')
  check(note?.role === 'user' && note?.source?.kind === 'plugin' && note?.source?.plugin === 'dsh-runaway-guard'
    && note?.source?.form === 'instructions',
    '追加的是 plugin 署名的 instructions 消息', JSON.stringify(note?.source))
  check(/不要再调用任何工具/.test(note?.content?.[0]?.text ?? ''), '指令要求停止工具调用并收尾')
  check(logs.some(([, m]) => /注入收尾指令/.test(m)), '警告日志说明了触发原因')

  check((await step(1, 26)).messages.length === 1, '宽限期内只劝一次，不重复灌消息')

  const hard = await step(1, 29)
  check(hard.kind === 'reject', '第 29 步（25+4）到硬阈值：拒绝开新步')
  check(logs.some(([, m]) => /已中止/.test(m) && /turn=1 step=29/.test(m)), '关轮日志带 session/turn/step')

  check((await step(2, 1)).messages.length === 1, '下一轮从第 1 步起重新计数')
}

console.log('▶ 2. 原地打转（同一条工具调用反复执行）')
{
  const { step } = harness(CFG, spinning(7, 3))
  const hit = await step(7, 4)
  check(hit.messages.length === 2 && /连续 3 次完全相同的工具调用/.test(hit.messages[1].content[0].text),
    '步数没到阈值，但重复 3 次同样触发劝退')

  const { step: s2 } = harness(CFG, spinning(7, 5))
  check((await s2(7, 6)).kind === 'reject', '重复到 5 次直接关轮')

  const { step: s3 } = harness(CFG, [asst(7), call(7, 'bash', 'ls -la'), asst(7), call(7, 'read', '{}'), asst(7), call(7, 'bash', 'ls -la')])
  check((await s3(7, 4)).messages.length === 1, '换着花样调用不算重复（名字/参数不同即不同）')
}

console.log('▶ 3. 不该插手的场合')
{
  const { step } = harness(CFG)
  check((await step(1, 40, [userBubble('user')])).messages.length === 1,
    '这一步领取了真人输入 → 即使远超硬阈值也放行')

  // 模型最后一句没再点工具 = 本轮正要自然收口，此时既不该劝退，也不该把
  // turn/end 从 'completed' 改成 'blocked'。
  const { step: s2 } = harness(CFG, [...steps(3, 30), asst(3, false)])
  const closing = await s2(3, 99)
  check(closing.kind === 'enter' && closing.messages.length === 1, '模型已给出无工具结论 → 完全不插手')

  const { step: s3 } = harness(CFG, spinning(3, 3))
  check((await s3(4, 3)).messages.length === 1, '只数当前轮的事件，不把上一轮的重复算进来')

  const { step: s4 } = harness(CFG, [])
  check((await s4(1, 999)).kind === 'enter', '读不到任何事件（无从判断）→ 不动手')
}

console.log('▶ 4. 配置与环境变量')
{
  const off1 = harness(CFG, steps(1, 30))
  check(off1.logs.some(([l, m]) => l === 'info' && /armed/.test(m)), '默认配置会打 armed 行')
  const disabled = harness({ ...CFG, enabled: false })
  check(disabled.handler === undefined, 'enabled:false → 压根不注册 pre-step 监听')
  check(disabled.logs.some(([, m]) => /disabled/.test(m)), '停用也留一行 info 便于事后确认')

  process.env.DSH_RUNAWAY_GUARD = '0'
  check(harness(CFG, steps(1, 30)).handler === undefined, 'DSH_RUNAWAY_GUARD=0 整体停用')
  delete process.env.DSH_RUNAWAY_GUARD

  process.env.DSH_RUNAWAY_GUARD_MAX_STEPS = '6'
  const tight = harness({}, steps(1, 6))
  check((await tight.step(1, 6)).messages?.[1] !== undefined, 'env 可以把阈值压到 6 步')
  delete process.env.DSH_RUNAWAY_GUARD_MAX_STEPS

  const junk = harness({ maxSteps: 'abc', graceSteps: -9 }, steps(1, 25))
  check((await junk.step(1, 25)).messages?.[1] !== undefined, '坏配置值退回默认（25 步），不会变成 0 步就掐')

  const tiny = harness({ maxSteps: 1 }, steps(1, 4))
  check((await tiny.step(1, 3)).messages?.[1] === undefined, 'maxSteps=1 被夹到下限，第 3 步还不动手')
  check((await tiny.step(1, 4)).messages?.[1] !== undefined, '下限 4 步处开始劝退')

  const eight = spinning(1, 8)
  const inverted = harness({ repeatLimit: 8, repeatHard: 2 }, eight)
  const inv = await inverted.step(1, 5)
  check(inv.kind === 'enter' && inv.messages?.[1] !== undefined,
    'repeatHard < repeatLimit 时自动抬高硬阈值：8 次重复只劝退，不关轮')
}

console.log('▶ 5. 健壮性：自己出错绝不连累对话')
{
  const logs = []
  const listeners = []
  apply({
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    on: (n, h) => listeners.push([n, h]),
  }, CFG)
  const handler = listeners[0][1]
  const boom = { id: 'x', session: { ownEvents: () => { throw new Error('boom') } }, options: {} }
  const out = await handler(
    { agent: boom, turn: 1, step: 99, messages: [userBubble()], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  check(out.kind === 'enter', 'session.ownEvents() 抛异常时照常放行')
  check(logs.some((m) => /stepping through/.test(m)), '但留下一行 warn')

  const noSession = harness(CFG)
  const weird = await (harness(CFG).step)(1, 99)
  check(weird.kind === 'enter', '空事件流下最坏也只是不干预')
  check((await noSession.step(1, 2, [undefined, null])) !== undefined, 'messages 里有空洞也不会抛')
}

console.log(failures === 0 ? '\n✅ dsh-runaway-guard 全部断言通过' : `\n❌ ${failures} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
