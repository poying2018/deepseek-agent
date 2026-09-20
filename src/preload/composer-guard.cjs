'use strict'
/**
 * 输入框点击兜底 + 无响应归因（preload 侧，纯函数便于测试）。
 *
 * ── 为什么重写 ──────────────────────────────────────────────────────────────
 * v1.3.6 的兜底找的是 `textarea` / `[contenteditable="true"]` 和 `[data-dsh-inputbar]`。
 * 2026-09-20 用 CDP 在实际构建里读 DOM，输入区真实形态是：
 *
 *   div[data-composer-input][role="textbox"][contenteditable="false"][data-phase="inert"]
 *
 * —— 那三个选择器**一个都匹配不到**（本构建里没有 data-dsh-inputbar，这个元素在
 * 不可输入时 contenteditable 是 "false"）。也就是说 v1.3.6 的兜底是**死代码**，
 * 用户当时报的「点了没反应」根本没被修到。这次按真实契约重写，并且把「修不了」的
 * 情形留下可归因的记录，而不是继续猜。
 *
 * ── 上游为什么可以「点了什么都不发生」────────────────────────────────────────
 * dsh-client-ui-conversation 的 InputBar 里（行号取自 0.1.5-rc.2 的构建产物）：
 *
 *   inert    = sessionId === undefined || (hero && chipTitle === undefined)
 *   disabled = removed || inert || !live || blocked !== undefined || parentOffline
 *   live     = input !== void 0 && keyboard !== void 0 && inputActions !== void 0
 *   machineBusy = phase === "adjudicating" || phase === "submitting"
 *   editable = live && !locked && !machineBusy
 *
 * 六个闸门任一关上，输入区就**外观不变地**不吃点击（上游注释自己写着 no-session
 * 与 workspace-picker 渲染同一个 div）。这些都不在发行版可改的范围内；我们只做两件事：
 *   ① 属于我们这边能修的：点击被**中间层吃掉**、而输入区本身是可输入的时候，补一次
 *      focus（这是 v1.3.6 原本的意图，只是选择器写错了）；
 *   ② 修不了的那些：确认这次点击确实什么都没发生后，记一行**归因**（哪个闸门关着），
 *      不记任何输入内容。有了归因才能对症修，而不是再来一次"猜一个补丁"。
 */

/** 输入区本体（上游 DOM 契约）：data-composer-input 是稳定钩子，role 兜底。 */
const FIELD_SELECTOR = '[data-composer-input], [role="textbox"][data-phase]'

/** 真正的交互元素：点在它们身上时一律不插手。 */
const INTERACTIVE_SELECTOR =
  'input, textarea, select, button, a[href], [contenteditable="true"], [role="button"], [role="menuitem"], [role="option"], [role="combobox"], [role="tab"], [role="dialog"], [aria-modal="true"]'

/** 这个元素此刻能不能吃输入；返回值同时是归因用的闸门名。 */
function fieldGate(field) {
  if (!field) return 'missing'
  const phase = field.getAttribute('data-phase')
  // 没选工作区：整个输入区是「选择工作区」触发器，不吃文字输入
  if (field.getAttribute('aria-haspopup') === 'menu') return 'no-workspace'
  if (phase === 'submitting' || phase === 'adjudicating') return 'busy'
  if (field.getAttribute('aria-disabled') === 'true') return 'disabled'
  if (phase === 'inert') return 'inert'
  // 上游 live 尚未就绪（input/keyboard/inputActions 还没挂齐）时 contenteditable 是 false
  if (field.getAttribute('contenteditable') !== 'true') return 'not-ready'
  return 'editable'
}

function rectContains(rect, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/**
 * 判断一次 pointerdown 该怎么处理。**纯函数**，不碰全局对象，便于用假 DOM 断言。
 * @param {{target: object, x: number, y: number, doc: {querySelectorAll: Function}}} input
 * @returns {{action: 'ignore'|'focus'|'attribute', field?: object, gate?: string}}
 */
function decideClick({ target, x, y, doc }) {
  if (!target || typeof target.closest !== 'function') return { action: 'ignore' }
  if (target.closest(INTERACTIVE_SELECTOR)) return { action: 'ignore' }
  const fields = [...doc.querySelectorAll(FIELD_SELECTOR)]
  for (const field of fields) {
    const r = typeof field.getBoundingClientRect === 'function' ? field.getBoundingClientRect() : null
    if (!r || r.width === 0 || r.height === 0) continue
    if (!rectContains(r, x, y)) continue
    const gate = fieldGate(field)
    if (gate === 'editable') {
      // 点在输入区上却没打到它 —— 中间隔着不该吃点击的层，这才是我们能补的那一类
      return { action: 'focus', field, gate }
    }
    // 闸门关着：不是我们能修的行为，但必须留下归因，否则用户只会觉得"又没反应"
    return { action: 'attribute', field, gate }
  }
  return { action: 'ignore' }
}

/** 这次点击之后，页面到底有没有反应（用于避免误报归因）。 */
function pageResponded({ doc, field, gate }) {
  const active = doc.activeElement
  if (field && (active === field || (field.contains && field.contains(active)))) return true
  // 弹层/菜单出现也算有反应（例如触发器态点开工作区选择器）
  const dialogs = [...doc.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')]
  return dialogs.some((el) => {
    const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
    return r && r.width > 40 && r.height > 40
  }) || (gate === 'no-workspace' && Boolean(active))
}

/** 归因载荷：只允许这些字段，绝不含任何用户输入内容。 */
function diagPayload({ gate, field, responded, now, appVersion }) {
  return {
    ts: typeof now === 'number' ? now : Date.now(),
    gate,
    phase: field ? field.getAttribute('data-phase') : null,
    editable: field ? field.getAttribute('contenteditable') : null,
    ariaDisabled: field ? field.getAttribute('aria-disabled') : null,
    hasPopup: field ? field.getAttribute('aria-haspopup') : null,
    hasPlaceholder: field ? Boolean(field.getAttribute('data-placeholder')) : false,
    responded,
    app: appVersion || null,
  }
}

/**
 * 装载兜底。依赖注入（window/document/send/setTimeout/appVersion），因此可以用假 DOM 测。
 * @returns {(event: object) => void} 已注册的处理器，便于测试直接驱动
 */
function installComposerGuard(deps) {
  const { window, document, send, setTimeoutImpl, appVersion } = deps
  const later = setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms))
  // 兜底自己坏掉时必须说出来，而且只说一次。教训很直接：v1.3.6 那版选择器写错之后
  // 一声不响地空转了好几个版本，用户每次"点了没反应"我们都在猜 —— 静默失效比报错难修得多。
  let complained = false
  const complain = (where, err) => {
    if (complained) return
    complained = true
    try { console.error(`[composer-guard] ${where} 出错（只报一次）: ${(err && err.message) || err}`) } catch {}
  }
  const handler = (event) => {
    try {
      const target = event.target
      const decision = decideClick({ target, x: event.clientX, y: event.clientY, doc: { querySelectorAll: (s) => document.querySelectorAll(s) } })
      if (decision.action === 'ignore') return
      if (decision.action === 'focus') {
        try { decision.field.focus() } catch (e) { complain('focus()', e) }
        return
      }
      // attribute：等一拍再看"到底有没有反应"，没反应才记，避免噪声
      const { field, gate } = decision
      later(() => {
        try {
          const responded = pageResponded({ doc: { activeElement: document.activeElement, querySelectorAll: (s) => document.querySelectorAll(s) }, field, gate })
          if (responded) return
          send(diagPayload({ gate, field, responded, now: Date.now(), appVersion }))
        } catch (e) { complain('归因', e) }
      }, 260)
    } catch (e) { complain('pointerdown', e) }
  }
  window.addEventListener('pointerdown', handler, true)
  return handler
}

module.exports = {
  FIELD_SELECTOR,
  INTERACTIVE_SELECTOR,
  fieldGate,
  decideClick,
  pageResponded,
  diagPayload,
  installComposerGuard,
}
