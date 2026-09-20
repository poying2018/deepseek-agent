// dsh-runaway-guard —— 单轮失控（runaway）看门狗。
//
// 要治的病：一轮对话里 Agent 自己转圈，几十步停不下来。实测过一次真实的失控：
// 同一轮 57 步 / 93 个不同工具调用，界面上是一串「Go. OK. Writing. Let me
// output.」，烧掉 11.2M token，最后还得用户手动点停止。
//
// 内核**没有**任何步数上限可配：dsh-agent-loop 的配置项只有
// maxParallelToolCalls（并行工具调用数，默认 10）。翻遍 @deepseek-ai/* 也没有
// maxSteps / stepLimit / turnBudget / shouldContinue 这类钩子。所以闸门只能自己加，
// 而加的位置是内核已经开好的那个口子：
//
//   ctx.on('agent/pre-step', (payload, next) => ...)
//     payload = { agent, messages, turn, step, signal }   // step 从 1 开始，每轮归零
//     返回 next() 的结果            → 照常进这一步
//     返回 { kind:'enter', messages:[...] , ...} → 换/加进入这一步的消息
//     返回 { kind:'reject' }        → 循环不再开新步，turn/end 的 reason 是
//                                     'blocked'（正常收尾，不是 error、不算中断）
//
// 之所以走 reject 而不是 agent.cancel({kind:'hook'})：cancel 是「掐断」，会留下
// 半截工具调用；reject 是「这一步不开了」，日志边界干净，和用户点停止之后的
// turn/end 语义一致但可归因。
//
// 两级反应，先劝后掐：
//   1) 软阈值：往这一步里追加一条 plugin 署名的 instructions 消息，要求模型
//      立刻停止调用工具并用一条消息交代结论。理想情况下用户拿到的是一个**真实
//      存在的收尾答复**，而不是一刀切的黑洞。
//   2) 硬阈值：软阈值之后再放行 graceSteps 步；还不收，或者同一条工具调用
//      （name + 参数完全一样）连续重复到硬次数，直接 reject 关掉这一轮。
//   两道闸门都只在「本轮最后一次模型输出确实又点了工具」时才检查——模型已经
//   说完、循环正要自然收口时一律不插手（见 scanTail 的 toolDriven）。
//
// ── v1.4.1 的关键调整：步数闸门默认关掉 ────────────────────────────────────
// v1.3.9 上线后用户反馈「每执行一步就要我说继续才会继续下去」。对着本机 22 会话 /
// 63 轮取证（脚本与数字见 DEFAULTS.maxSteps 的注释）：中位数就是 25 步、P99 239 步，
// 每轮 token 中位 2.98M、P99 56.2M —— **都比当初那次"失控"（57 步 / 11.2M）更高**。
// 也就是说按步数或花费设阈值，掐掉的正是用户的正事：软阈值那条"停止调用工具"一旦
// 注入，模型立刻收尾，剩下的活儿必须由用户再说一次"继续"才继续 —— 半个轮次被打断一次。
// 所以默认值改成 maxSteps=0（不设步数上限），只留「同一工具调用原样连重」这个
// 在 63 轮里最长连续只有 1 次、误伤率为零的信号。代价要说清楚：像当初那次
// "93 个不同调用、每个都在动但整体没进展"的失控，现在**不会被自动拦下**——
// 因为在本机的数据里，它与正常重活儿在可观测信号上无法区分。宁可漏拦，不可拦错。
//
// 误伤防线：**只要这一步已经领取了真人输入（source.kind === 'user'）就完全放行。**
// 用户在手动 steer / 排队输入，说明人在盯着，此时按「失控」处理是最难接受的误报。
//
// 零依赖：不 import 任何 @deepseek-ai/* 包。需要一条 user-role 消息时直接手搓
// 对象（createUserMessage 的全部实质就是 { ...input, role:'user', id:uuid } 再加
// 冻结），于是插件既不占打包暂存里的解析链接，也不会因为内核升轨而改签名失配。
// dsh-session 的 assertMessageEventShape 对 user/message 只要求：id 非空字符串、
// role === 'user'、source.kind 非空字符串、content 是数组 —— 手搓的对象全部满足。
// 三种决策（放行 / 追加指令 / reject）由 `pnpm check:guard` 守住；把它挂上真实
// cordis dispatcher 的链路也在一次性探针里跑通过（ctx.plugin + ctx.waterfall）。

import { randomUUID } from 'node:crypto'

export const name = 'dsh-runaway-guard'

/** 不需要任何宿主服务：pre-step 的 payload 自带 agent / turn / step。 */
export const inject = []

const DEFAULTS = {
  enabled: true,
  /**
   * 软阈值：单轮步数到这里开始劝退。**默认 0 = 不按步数设限**，原因见下面这段实测。
   *
   * 2026-09-20 对着本机 22 个会话 / 63 个轮次量了一遍真实工作流：
   *   每轮步数  中位数 25｜P75 34｜P90 55｜P95 86｜P99 239（且那轮 239 步是正常完成的）
   *   每轮 token（in+out+cache 累加）中位数 2.98M｜P90 15.6M｜P99 56.2M
   * 而当初促成这个插件的那次失控只有 57 步 / 11.2M token —— **低于本机的日常水位**。
   * 于是"步数到 25 就劝退"这个默认值（v1.3.9 上线值）会把大约一半的正常轮次打断：
   * 现场表现为模型被注入"预算已经用完，停止调用工具"后立刻收尾，用户只能再说一次
   * "继续"才能往下走 —— 也就是用户报的"每执行一步就要我说继续"。
   * 结论：花费量和步数都**不是**失控的判据（区分不了"重活儿"和"打转"），
   * 只有"同一个工具调用原样重复"才是 —— 而它在 63 轮里的最长连续值是 1。
   * 需要硬上限的人可以用 settings 或 DSH_RUNAWAY_GUARD_MAX_STEPS 显式打开。
   */
  maxSteps: 0,
  /** 劝退之后额外放行的步数；用完还没收就硬关。仅在 maxSteps > 0 时有意义。 */
  graceSteps: 4,
  /** 软阈值：完全相同的工具调用连续出现这么多次也算原地打转。 */
  repeatLimit: 4,
  /** 硬阈值：相同工具调用出现到这个次数直接关轮（再重复下去只是烧钱）。 */
  repeatHard: 8,
}

const PLUGIN_ID = 'dsh-runaway-guard'

/** 取整数配置：settings 里给的是字符串也能用，越界值夹回可用区间。 */
function intOf(value, fallback, min, max) {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** env 覆盖优先于 settings，最后才用默认值：方便临时关掉或调松。 */
function resolveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const env = typeof process !== 'undefined' && process.env ? process.env : {}
  const enabled = env.DSH_RUNAWAY_GUARD === '0'
    ? false
    : env.DSH_RUNAWAY_GUARD === '1'
      ? true
      : src.enabled === false || src.enabled === 'false'
        ? false
        : DEFAULTS.enabled
  return {
    enabled,
    maxSteps: intOf(env.DSH_RUNAWAY_GUARD_MAX_STEPS ?? src.maxSteps, DEFAULTS.maxSteps, 0, 1000),
    graceSteps: intOf(env.DSH_RUNAWAY_GUARD_GRACE_STEPS ?? src.graceSteps, DEFAULTS.graceSteps, 1, 100),
    repeatLimit: intOf(env.DSH_RUNAWAY_GUARD_REPEAT_LIMIT ?? src.repeatLimit, DEFAULTS.repeatLimit, 2, 100),
    // 硬阈值必须晚于软阈值，否则第一次触发就是关轮，等于没有劝退这一步。
    repeatHard: Math.max(intOf(env.DSH_RUNAWAY_GUARD_REPEAT_HARD ?? src.repeatHard, DEFAULTS.repeatHard, 2, 200),
      intOf(env.DSH_RUNAWAY_GUARD_REPEAT_LIMIT ?? src.repeatLimit, DEFAULTS.repeatLimit, 2, 100) + 1),
  }
}

/** 工具调用指纹：名字 + 压掉空白的参数。参数相同才算「同一条调用」。 */
function fingerprintOf(data) {
  const args = typeof data?.arguments === 'string' ? data.arguments : JSON.stringify(data?.arguments ?? '')
  return `${data?.name ?? '?'}\u0000${args.replace(/\s+/g, ' ').trim()}`
}

/**
 * 从会话日志尾部一次往回走，同时得到两件事：
 *   · repeats/sample —— 当前轮里最新若干条 tool/call 的连续相同次数与那条指纹；
 *   · toolDriven     —— 本轮最后一次 assistant/message 是否带着 tool-call 块，
 *                       也就是「循环是因为工具还没跑完才继续」还是「模型已经给出
 *                       结论、正打算自然收口」。
 *
 * toolDriven 这个判据是实机测出来的：正常工具轮里 pre-step 领取到的 messages
 * 往往是空的（工具结果走 tool/result 事件进历史，不再作为 user/message 领取），
 * 所以**不能**拿 messages.length 当「循环要不要继续」的信号——真机第一版就是被
 * 它骗过，软阈值那次劝退压根没发出去。判「上一次模型输出有没有再调工具」才对。
 *
 * 只读 session.ownEvents()（内存里的事件数组），不解析落盘文件；从尾部走并限定
 * 读取条数（cap），所以一轮里堆几千条事件也不会放大成每步的全量扫描。
 *
 * @param session - 这一轮的会话（payload.agent.session）。
 * @param turn - 当前轮号，跨轮的事件一律不算数。
 * @param cap - 最多往回看多少条事件。
 * @returns {count, sample, toolDriven}
 */
function scanTail(session, turn, cap) {
  const events = typeof session?.ownEvents === 'function' ? session.ownEvents() : []
  const empty = { count: 0, sample: '', toolDriven: false }
  if (!Array.isArray(events) || events.length === 0) return empty
  let count = -1
  let sample = ''
  let toolDriven = null
  for (let i = events.length - 1, seen = 0; i >= 0 && seen < cap; i -= 1, seen += 1) {
    const event = events[i]
    if (event?.type === 'turn/start' && event?.data?.turn !== turn) break
    if (event?.data?.turn !== turn) continue
    if (event.type === 'assistant/message') {
      // 日志顺序是 assistant/message → tool/call → tool/result，所以第一次撞上的
      // assistant/message 就是本轮最后一次模型输出：它有没有再点工具，决定循环
      // 是「被工具拖着继续」还是「已经说完、正要收口」。计数继续往旧走。
      if (toolDriven === null) {
        const blocks = event?.data?.message?.content
        toolDriven = Array.isArray(blocks) && blocks.some((b) => b?.type === 'tool-call')
      }
      continue
    }
    if (event.type !== 'tool/call') continue
    const fp = fingerprintOf(event.data)
    if (count < 0) {
      count = 1
      sample = fp
    } else if (fp === sample) {
      count += 1
    } else break
  }
  return { count: count < 0 ? 0 : count, sample, toolDriven: toolDriven === true }
}

/** 劝退指令：中英各一句，写清楚「别再调工具」和「交代什么」。 */
function wrapUpText(reason) {
  return [
    `[${PLUGIN_ID}] ${reason}`,
    '',
    '预算已经用完。从现在起不要再调用任何工具（包括读文件、检索、执行命令），',
    '直接用一条消息收尾，依次写清楚：',
    '1) 目前已经得出的结论；2) 已经改动或产出了哪些文件；3) 还没做完的部分，以及建议的下一步。',
    '如果确实必须再来一次工具调用才能回答，请只说明缺什么、为什么缺，然后停下。',
    '',
    `The runaway-guard budget for this turn is exhausted (${reason}). Stop calling tools and answer with a plain-text wrap-up now.`,
  ].join('\n')
}

/** 手搓一条 plugin 署名的 user-role instructions 消息（等价于 createUserMessage）。 */
function instructionMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: PLUGIN_ID, form: 'instructions' }),
  })
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  /** agent → { turn, noticed }；进程级状态，重启即清零，够用。 */
  const states = new WeakMap()

  if (!cfg.enabled) {
    ctx.logger.info(`${PLUGIN_ID}: disabled`)
    return
  }

  const stepCapOn = cfg.maxSteps > 0
  const hardSteps = cfg.maxSteps + cfg.graceSteps

  ctx.on('agent/pre-step', (payload, next) => {
    const run = async () => {
      const decision = await next()
      try {
        const agent = payload?.agent
        const turn = payload?.turn
        const step = payload?.step
        if (!agent || !Number.isInteger(turn) || !Number.isInteger(step)) return decision
        if (decision?.kind !== 'enter') return decision

        let state = states.get(agent)
        if (!state || state.turn !== turn) {
          state = { turn, noticed: false }
          states.set(agent, state)
        }

        // 人在开车：这一步吃了真人输入（steer / 排队消息），不干预。
        if (decision.messages?.some?.((m) => m?.source?.kind === 'user')) return decision

        // 一次读取，三个判据共用：并行工具调用时每步可能有多条 call（内核默认
        // maxParallelToolCalls=10），所以往回看的窗口按每步 12 条留量。
        const { count, sample, toolDriven } = scanTail(
          agent.session, turn, Math.max(24, (cfg.repeatHard + 1) * 12),
        )
        // 不在工具圈里（本轮最后一次模型输出没再点工具，或者根本还没跑过步）：
        // 循环自己就要收口了，看门狗不插手——既不必劝退，也不该把 turn/end 从
        // 'completed' 改成 'blocked'。
        if (!toolDriven) return decision

        const stepOverSoft = stepCapOn && step >= cfg.maxSteps
        const stepOverHard = stepCapOn && step >= hardSteps
        const repeatSoft = count >= cfg.repeatLimit
        const repeatHard = count >= cfg.repeatHard
        const label = agent.id ?? 'unknown'

        if (stepOverHard || repeatHard) {
          ctx.logger.warn(
            `${PLUGIN_ID}: 已中止 session="${label}" turn=${turn} step=${step} —— `
            + `单轮步数上限 ${hardSteps}${repeatHard ? ` / 同一工具调用连续 ${count} 次` : ''}，`
            + `判定为失控（loop runaway）。${sample ? `重复调用: ${sample.split('\u0000')[0]}` : ''}`,
          )
          return { kind: 'reject' }
        }

        // 软阈值：往这一步追加一条 plugin 署名的 instructions 消息，要求模型停止
        // 调工具并给出结论。driver 会把这一步的 messages 逐条 append 成 user/message
        // 事件，source.kind='plugin' + form='instructions' 与内核自己的 system-prompt
        // snapshot / skill catalog 注入同族，因此不会画成用户气泡。
        if ((stepOverSoft || repeatSoft) && !state.noticed) {
          state.noticed = true
          const reason = repeatSoft
            ? `检测到连续 ${count} 次完全相同的工具调用（${sample.split('\u0000')[0]}）`
            : `本轮已执行 ${step} 步，达到单轮阈值 ${cfg.maxSteps} 步`
          ctx.logger.warn(`${PLUGIN_ID}: session="${label}" turn=${turn} step=${step} —— ${reason}，注入收尾指令`)
          return {
            ...decision,
            messages: [...decision.messages, instructionMessage(wrapUpText(reason))],
          }
        }

        return decision
      } catch (error) {
        // 看门狗自己出错绝不能连累对话：放行本步，只留一行日志。
        ctx.logger.warn(`${PLUGIN_ID}: listener failed, stepping through: ${String(error?.stack ?? error)}`)
        return decision
      }
    }
    return run()
  })

  ctx.logger.info(
    `${PLUGIN_ID}: armed (步数上限=${stepCapOn ? `${cfg.maxSteps}+${cfg.graceSteps}` : '关闭（默认：实测证明步数不是失控判据，见文件头）'}, `
    + `同一调用连重=${cfg.repeatLimit}/${cfg.repeatHard})`,
  )
}
