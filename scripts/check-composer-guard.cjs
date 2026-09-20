/**
 * 输入框兜底的回归检查（`pnpm check:composer`）。
 *
 * 为什么需要：v1.3.6 那次"修点击没反应"用的选择器在实际构建的 DOM 上一个都匹配不到
 * （详见 src/preload/composer-guard.cjs 顶部），等于修了个寂寞 —— 而且没有任何测试会
 * 因此变红。这里把真实 DOM 形态做成夹具钉住，顺便钉住另一件事：**归因记录里绝不能
 * 出现用户的输入内容**。
 */
const assert = require('node:assert')
const { join } = require('node:path')

const G = require(join(__dirname, '..', 'src', 'preload', 'composer-guard.cjs'))
const { FIELD_SELECTOR, fieldGate, decideClick, diagPayload, installComposerGuard } = G

let n = 0, bad = 0
const t = (name, fn) => { n += 1; try { fn(); console.log(`  ✅ ${name}`) } catch (e) { bad += 1; console.log(`  ❌ ${name}\n     ${e.message}`) } }

/** 最小假元素：只实现兜底真正用到的接口。 */
function el(attrs, { rect = { left: 100, top: 300, right: 700, bottom: 360, width: 600, height: 60 }, interactiveTags = [] } = {}) {
  const self = {
    attrs,
    focused: false,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getBoundingClientRect: () => rect,
    contains: (other) => other === self,
    focus() { self.focused = true },
    closest: (sel) => {
      // 只需识别"是不是交互元素"这一类判断
      const tag = (attrs.__tag || '').toLowerCase()
      return interactiveTags.includes(tag) || sel.includes('role=') && attrs.role ? (selectorHits(sel, self) ? self : null) : (selectorHits(sel, self) ? self : null)
    },
  }
  self.__self = self
  return self
}
function selectorHits(sel, node) {
  for (const part of sel.split(',').map((s) => s.trim())) {
    if (part.startsWith('[')) {
      const m = part.match(/^\[([a-z-]+)(?:="([^"]+)")?\]$/)
      if (!m) continue
      const [, k, v] = m
      if (!(k in node.attrs)) continue
      if (v === undefined || node.attrs[k] === v) return true
    } else if (part && node.attrs.__tag === part) return true
  }
  return false
}
const doc = (fields) => ({ querySelectorAll: (sel) => fields.filter((f) => selectorHits(sel, f) || sel === FIELD_SELECTOR && ('data-composer-input' in f.attrs || (f.attrs.role === 'textbox' && 'data-phase' in f.attrs))) })

console.log('▶ 1. 真实契约：输入区是 div[data-composer-input][role=textbox]，不是 textarea')
const realShape = el({ __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'true', 'data-phase': 'plain' })
t('新选择器能命中真实形态的输入区', () => {
  assert.ok(doc([realShape]).querySelectorAll(FIELD_SELECTOR).length === 1, 'FIELD_SELECTOR 没命中')
})
t('旧选择器（textarea / [contenteditable="true"]）在 contenteditable=false 时命中不了 —— 这正是 v1.3.6 死掉的原因', () => {
  const inert = el({ __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'false', 'data-phase': 'inert' })
  const old = [realShape, inert].filter((f) => selectorHits('textarea, [contenteditable="true"]', f))
  assert.strictEqual(old.length, 1, '旧选择器现在能命中 1 个（可编辑那个），但 inert 态必然漏')
  const inertOnly = [inert].filter((f) => selectorHits('textarea, [contenteditable="true"]', f))
  assert.strictEqual(inertOnly.length, 0, 'inert 态应被旧选择器漏掉')
})

console.log('▶ 2. 该补的就补、不该碰的绝不碰')
t('点在输入区矩形内、但事件目标是覆盖层 → 补一次 focus', () => {
  const overlay = el({ __tag: 'div' })
  const d = decideClick({ target: overlay, x: 300, y: 330, doc: doc([realShape]) })
  assert.strictEqual(d.action, 'focus')
  assert.strictEqual(d.field, realShape)
})
t('点已经在真正的交互元素上 → 完全不插手', () => {
  const btn = el({ __tag: 'button', role: 'button' })
  const d = decideClick({ target: btn, x: 300, y: 330, doc: doc([realShape]) })
  assert.strictEqual(d.action, 'ignore')
})
t('点不在输入区矩形内 → 不插手', () => {
  const other = el({ __tag: 'div' })
  const d = decideClick({ target: other, x: 50, y: 50, doc: doc([realShape]) })
  assert.strictEqual(d.action, 'ignore')
})

console.log('▶ 3. 上游六个闸门的归因（我们改不了行为，但必须说清楚是哪个）')
const gateCases = [
  ['contenteditable=false 且 phase=plain（上游 live 未就绪）', { __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'false', 'data-phase': 'plain' }, 'not-ready'],
  ['没选工作区（触发器态）', { __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'false', 'data-phase': 'inert', 'aria-haspopup': 'menu' }, 'no-workspace'],
  ['正在提交/裁决（machineBusy）', { __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'true', 'data-phase': 'submitting' }, 'busy'],
  ['会话被 block / 只读', { __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'true', 'data-phase': 'plain', 'aria-disabled': 'true' }, 'disabled'],
  ['phase=inert 但无 haspopup（会话尚未绑定）', { __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'false', 'data-phase': 'inert' }, 'inert'],
]
for (const [label, attrs, want] of gateCases) {
  t(`${label} → gate=${want}`, () => {
    const f = el(attrs)
    assert.strictEqual(fieldGate(f), want)
    const d = decideClick({ target: el({ __tag: 'div' }), x: 300, y: 330, doc: doc([f]) })
    assert.strictEqual(d.action, 'attribute', '闸门关着时应走归因而不是假装聚焦')
    assert.strictEqual(d.gate, want)
  })
}

console.log('▶ 4. 装载：没反应才记一条，有反应就闭嘴')
function harness(field, activeElement) {
  const sent = []
  const timers = []
  const listeners = {}
  const win = { addEventListener: (name, fn) => { listeners[name] = fn } }
  const ddoc = {
    activeElement,
    querySelectorAll: (sel) => (sel === FIELD_SELECTOR ? [field] : []),
  }
  installComposerGuard({ window: win, document: ddoc, send: (p) => sent.push(p), setTimeoutImpl: (fn) => timers.push(fn), appVersion: '1.4.3' })
  listeners.pointerdown({ target: el({ __tag: 'div' }), clientX: 300, clientY: 330 })
  timers.forEach((fn) => fn())
  return { sent, field }
}
t('闸门关着且无响应 → 记一条归因', () => {
  const f = el({ __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'false', 'data-phase': 'plain' })
  const { sent } = harness(f, el({ __tag: 'body' }))
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].gate, 'not-ready')
  assert.strictEqual(sent[0].responded, false)
})
t('其实已经聚焦了 → 不记（避免噪声）', () => {
  const f = el({ __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'false', 'data-phase': 'plain' })
  const { sent } = harness(f, f)
  assert.strictEqual(sent.length, 0)
})
t('可编辑且被中间层吃掉 → 直接 focus，不记归因', () => {
  const f = el({ __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'true', 'data-phase': 'plain' })
  const { sent } = harness(f, el({ __tag: 'body' }))
  assert.strictEqual(f.focused, true, '应当补一次 focus')
  assert.strictEqual(sent.length, 0)
})

console.log('▶ 5. 隐私：归因载荷是封闭字段集，不含任何输入内容')
t('载荷字段白名单固定', () => {
  const f = el({ __tag: 'div', 'data-composer-input': 'true', role: 'textbox', contenteditable: 'false', 'data-phase': 'plain', 'data-placeholder': '说点什么…', textContent: '用户的秘密草稿' })
  const p = diagPayload({ gate: 'not-ready', field: f, responded: false, now: 1, appVersion: '1.4.3' })
  const allowed = new Set(['ts', 'gate', 'phase', 'editable', 'ariaDisabled', 'hasPopup', 'hasPlaceholder', 'responded', 'app'])
  for (const k of Object.keys(p)) assert.ok(allowed.has(k), `多出字段 ${k}`)
  const blob = JSON.stringify(p)
  assert.ok(!blob.includes('秘密草稿'), '载荷里混进了元素文本')
  assert.ok(!('placeholder' in p) || p.placeholder === undefined, '不能回传 placeholder 文本')
  assert.strictEqual(p.hasPlaceholder, true, '只允许记录"有没有占位文案"这个布尔值')
})

console.log('▶ 6. 自己坏掉时必须出声（v1.3.6 就是静默空转才被拖了三个版本）')
t('内部异常会被报一次，而不是静默吞掉', () => {
  const errs = []
  const orig = console.error
  console.error = (m) => errs.push(String(m))
  try {
    const listeners = {}
    const boomDoc = { activeElement: null, querySelectorAll: () => { throw new Error('boom') } }
    installComposerGuard({
      window: { addEventListener: (name, fn) => { listeners[name] = fn } },
      document: boomDoc,
      send: () => {},
      setTimeoutImpl: (fn) => fn(),
      appVersion: 'x',
    })
    listeners.pointerdown({ target: el({ __tag: 'div' }), clientX: 300, clientY: 330 })
    listeners.pointerdown({ target: el({ __tag: 'div' }), clientX: 300, clientY: 330 })
    assert.strictEqual(errs.length, 1, `应当恰好报一次，实际 ${errs.length} 次`)
    assert.ok(/boom/.test(errs[0]), '报的内容要带上真正的错误')
  } finally { console.error = orig }
})

console.log(`\n${bad === 0 ? '✅' : '❌'} 输入框兜底 ${n} 组断言${bad ? `，${bad} 处失败` : '全部通过'}`)
process.exit(bad ? 1 : 0)
