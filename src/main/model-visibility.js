/**
 * 计算「默认隐藏」的第三方模型 provider 名单（未完成鉴权的那些）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 内核的模型目录（`buildModelCatalog`）对「已注册适配器」的 provider 一律照单全收：
 * 插件装了、适配器注册了，它的模型就会出现在选择器里 —— **与该 provider 到底有没有
 * 登录过无关**。于是没登录过 trae / grok / gemini / codearts 的用户，列表里照样有
 * 一堆选了也发不出消息的「幽灵模型」，既误导又让人以为功能坏了。
 *
 * 宿主壳在**启动内核之前**算出这份名单，经环境变量 `LJANX_HIDDEN_MODELS` 交给内核；
 * 内核侧的过滤在 src/main/plugin-compat.js 里对
 * `@deepseek-ai/dsh-api-session-controller` 打的那条补丁里（只过滤选择器可见性，
 * 不动路由与请求校验，设置页的 Models 页仍列出全部 provider 供用户去登录）。
 *
 * ── 判据（保守：只隐藏"确信没鉴权"的）────────────────────────────────────
 * 只考察**已知需要鉴权的第三方 provider**（白名单，见下）。一个 provider 只要命中
 * 任一「已鉴权」信号就**保留**：
 *   · settings.yaml 的 jet-hub 账号池里，有它的 `enabled: true` 账号；
 *   · .credentials.yaml 里有它的凭据条目（`<PROVIDER>_ACCOUNT_*` 等）；
 *   · 数据目录里有它的 OAuth 文件（`<provider>-oauth.json`）。
 *
 * 解析全部是「不抛异常」的：任何一步读不到/解析失败都退回**不隐藏**（等价上游行为）。
 * 也就是说这个功能最坏情况是「不起作用」，不会误伤到「把在用的 provider 藏起来」。
 *
 * 用户想恢复完整列表：删掉 `$DSH_HOME/ljanx-hidden-models.json` 里对应项，
 * 或者在设置页完成一次该 provider 的登录（重启后自动回到列表）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 需要鉴权才能用的第三方 provider 白名单。
 * 只隐藏这里的 id —— 不在这份名单里的（DeepSeek 官方路由等）永远不动。
 */
export const AUTH_REQUIRED_PROVIDERS = [
  'codearts', // 华为云 CodeArts（dsh-codearts-auth）
  'buddy', // 腾讯 CodeBuddy 国内版（dsh-codearts-auth）
  'workbuddy', // WorkBuddy 国际版（dsh-codearts-auth）
  'lobsterai', // 有道 LobsterAI（dsh-codearts-auth）
  'trae', // 字节 Trae（dsh-connect-trae）
  'grok', // xAI Grok（dsh-grok-oauth）
  'gemini', // Google Gemini（dsh-gemini-oauth）
  'qoder', // Qoder CN（用户自装 dsh-provider-qoder）
]

/**
 * 从 settings.yaml 文本里抠出 `jet-hub.accounts` 中**启用**的 provider 集合。
 *
 * 不走 YAML 库：这里只需要一个很窄的切片（顶层 `jet-hub:` 段 → `accounts:` 列表 →
 * 每条的 `provider` / `enabled`）。手写扫描避免给主进程引入额外解析依赖，
 * 而且任何不认识的形状都会安全地退化成空集合（= 谁都不隐藏由凭据文件兜底）。
 *
 * @param {string} text settings.yaml 全文
 * @returns {Set<string>} 有启用账号的 provider id
 */
export function readJetHubEnabledProviders(text) {
  const out = new Set()
  if (typeof text !== 'string' || text.length === 0) return out

  // 1. 截出顶层 `jet-hub:` 段（到下一个顶格键为止）
  const startMatch = /^jet-hub:[ \t]*$/m.exec(text)
  if (!startMatch) return out
  const afterHeader = text.slice(startMatch.index + startMatch[0].length)
  const nextTopKey = /^\S/m.exec(afterHeader.slice(1))

  // 排除开头那个换行，避免把紧邻的下一行首字符误判成顶格键
  const block = nextTopKey ? afterHeader.slice(0, nextTopKey.index + 1) : afterHeader

  // 2. 按 `- id:` 切分账号条目
  for (const item of block.split(/^[ \t]*-[ \t]*id:/m).slice(1)) {
    const provider = /^[ \t]*provider:[ \t]*([A-Za-z0-9_-]+)[ \t]*$/m.exec(item)?.[1]
    if (!provider) continue
    // 没写 enabled 视为启用（与内核默认一致）；只有显式 false 才算停用
    const disabled = /^[ \t]*enabled:[ \t]*false[ \t]*$/m.test(item)
    if (!disabled) out.add(provider.toLowerCase())
  }
  return out
}

/**
 * 从 .credentials.yaml 文本里找出「有哪些 provider 的凭据」。
 * 只做形如 `  <PREFIX>_ACCOUNT_...:` / `  <PREFIX>_...:` 的顶格缩进键名匹配。
 *
 * @param {string} text .credentials.yaml 全文
 * @returns {(prefix: string) => boolean} 询问某前缀是否有凭据
 */
export function credentialRefMatcher(text) {
  return (prefix) => {
    const p = String(prefix || '').toUpperCase().replace(/[^A-Z0-9_]/g, '')
    if (!p) return false
    return new RegExp(`^[ \\t]+${p}(_ACCOUNT_|_[A-Z0-9_]*_|[A-Z0-9_]*:)[^\\n]*`, 'm').test(text)
  }
}

/**
 * 计算隐藏名单。
 *
 * @param {object} opts
 * @param {string} opts.dshHome 隔离数据目录（内核的 DSH_HOME）
 * @returns {{ hidden: string[], authenticated: string[], wrote: boolean, reason?: string }}
 */
export function computeHiddenProviders({ dshHome }) {
  const result = { hidden: [], authenticated: [], wrote: false }
  if (!dshHome) {
    result.reason = 'no-dsh-home'
    return result
  }

  let settingsText = ''
  let credentialsText = ''
  let sawSource = false

  const settingsPath = join(dshHome, 'settings.yaml')
  if (existsSync(settingsPath)) {
    try {
      settingsText = readFileSync(settingsPath, 'utf8')
      sawSource = true
    } catch {
      /* 读不到就当没这份数据 */
    }
  }

  const credentialsPath = join(dshHome, '.credentials.yaml')
  if (existsSync(credentialsPath)) {
    try {
      credentialsText = readFileSync(credentialsPath, 'utf8')
      sawSource = true
    } catch {
      /* 同上 */
    }
  }

  // 一份来源都读不到 ⇒ 无从判断，宁可不隐藏（等价上游行为）
  if (!sawSource) {
    result.reason = 'no-source'
    return result
  }

  const jetHubEnabled = readJetHubEnabledProviders(settingsText)
  const hasCredential = credentialRefMatcher(credentialsText)

  for (const provider of AUTH_REQUIRED_PROVIDERS) {
    const oauthFileExists =
      existsSync(join(dshHome, `${provider}-oauth.json`)) ||
      existsSync(join(dshHome, `${provider}-oauth-models.json`))

    const authenticated = jetHubEnabled.has(provider) || oauthFileExists || hasCredential(provider)
    if (authenticated) result.authenticated.push(provider)
    else result.hidden.push(provider)
  }

  // 落盘一份「人类可读」的清单，方便排查/手动放行（内核不读这个文件，
  // 它只读环境变量；这里纯粹是给人看的现场证据）。
  try {
    const reportPath = join(dshHome, 'ljanx-hidden-models.json')
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          note: '未完成鉴权的第三方 provider 默认从模型选择器隐藏；完成登录后重启即恢复。此文件仅供排查，内核读的是 LJANX_HIDDEN_MODELS 环境变量。',
          hidden: result.hidden,
          authenticated: result.authenticated,
        },
        null,
        2,
      ) + '\n',
    )
    result.wrote = true
  } catch {
    /* 写不进去不影响功能 */
  }

  return result
}
