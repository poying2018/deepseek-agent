/**
 * 第三方插件的兼容补丁（表驱动，构建期与运行期共用同一张表）。
 *
 * 为什么要两处消费：
 *  · 打进安装包的插件由 scripts/prepare-bundle.js 在暂存进 bundle-runtime 时改写；
 *  · 用户从应用内（npm）装的第三方插件落在 <DSH_HOME>/profiles/web/node_modules，
 *    构建期看不到它们 —— 所以宿主启动时（ServerManager.initIsolatedProfile）也要拿
 *    同一张表跑一遍，否则社区插件的兼容修复只对自带插件生效。
 *
 * 两条路径都必须幂等：已打过就跳过，锚点没命中只告警不中断（上游改结构时仍能起用，
 * 只是需要人工同步补丁）。放在 src/main/ 是因为 electron-builder 的 files 只收 src/**。
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 补丁执行结果的「戳记」文件名（放在插件目录内，随插件一起被删/被更新覆盖）。
 *
 * ── 为什么需要它（启动速度）────────────────────────────────────────────────
 * 这条补丁链是**每次启动**都要跑的（第三方插件构建期看不到，只能运行期补）。
 * 而幂等判断原先是「把目标文件整份读进来、看有没有已经补过」，于是每次冷启动都要
 * 主线程同步读几 MB 的 JS —— 例如 seaglass / dream-skin 的 client.js 各 350～390KB，
 * 加上内核那两个包，光是"确认已经打过"就要读掉一两兆。这些读都发生在**内核 spawn
 * 之前**，直接叠进用户感知的启动时间里。
 *
 * 戳记把「读文件」降级成「stat 文件」：
 *   · 记下每条 edit 的签名（补丁定义 + 文件相对路径）与每个目标文件的 size/mtimeMs；
 *   · 下次启动若签名一致、且所有文件 size+mtimeMs 都没变 ⇒ 直接跳过，**一个字节都不读**；
 *   · 任一文件变了（插件升级/被手改）⇒ 走原来的完整校验路径，行为不变。
 * 安全性：戳记只是"省一次读"，判断依据仍是文件自身的 size+mtime；戳记丢失/损坏时
 * 回退到读文件校验，不会漏打补丁。
 */
const STAMP_FILE = '.ljanx-compat-stamp.json'

/** 把一条 entry 的补丁定义折叠成短签名，用于判断"补丁表变过没有"。 */
function entrySignature(entry) {
  const h = createHash('sha1')
  h.update(entry.plugin)
  for (const edit of entry.edits) {
    h.update(edit.file)
    h.update(edit.fromLines ? edit.fromLines.join('\n') : String(edit.from ?? ''))
    h.update(edit.toLines ? edit.toLines.join('\n') : String(edit.to ?? ''))
  }
  return h.digest('hex').slice(0, 16)
}

/** 目标文件的 `size:mtimeMs` 指纹（读不到返回 null，调用方据此放弃跳过）。 */
function fileFingerprint(dir, relPath) {
  try {
    const st = statSync(join(dir, relPath))
    return `${st.size}:${Math.trunc(st.mtimeMs)}`
  } catch {
    return null
  }
}

/**
 * 读取戳记并判断「可以整段跳过吗」。
 * @returns {{ skip: boolean, files: Record<string, string>, sig: string }}
 */
function readStamp(dir, entry) {
  const sig = entrySignature(entry)
  let stamp = null
  try {
    stamp = JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'))
  } catch {
    return { skip: false, files: {}, sig }
  }
  if (!stamp || stamp.sig !== sig || typeof stamp.files !== 'object' || stamp.files === null) {
    return { skip: false, files: {}, sig }
  }
  // 逐个核对指纹：任一不一致（或读不到）就不跳过
  const files = {}
  for (const edit of entry.edits) {
    const fp = fileFingerprint(dir, edit.file)
    if (fp === null) return { skip: false, files: {}, sig } // 目标文件不存在 ⇒ 让它走正常流程去告警
    files[edit.file] = fp
    if (stamp.files[edit.file] !== fp) return { skip: false, files: {}, sig }
  }
  return { skip: true, files, sig }
}

/** 写入戳记（失败无所谓：下次只是多读一次文件）。 */
function writeStamp(dir, sig, files) {
  try {
    writeFileSync(join(dir, STAMP_FILE), JSON.stringify({ sig, files, at: new Date().toISOString() }) + '\n')
  } catch {
    /* 只读目录（如 asar 内）拿不到写权限，忽略 */
  }
}

/**
 * 逐插件的兼容补丁清单。每条 edits 是一次「行内字符串整段替换」，
 * 锚点必须带上相邻注释以保证唯一（单行锚点在压缩过的上游文件里常出现多次）。
 */
export const PLUGIN_RUNTIME_PATCHES = [
  // ── 已删掉的补丁（留墓碑，别再加回来）────────────────────────────────────
  //  dsh-codearts-auth「登录只开一个系统浏览器」：这条补丁在 2026-09 期间静默失效过
  //  三次，锚点在 `codearts.login({...})` 与 `startLogin()` 之间来回摆动。
  //  2026-09-20 对着 gitee master `0ae3359` 复核：CodeArts 分支现在是
  //  `const started = await codearts.startLogin({ refName })`（两步式：立即返回
  //  loginUrl，后台等回调），而 `src/service.ts` 的 startLogin **根本不含任何开浏览器
  //  实现**（宿主侧 openBrowser / shell.openExternal 只存在于 buddy / lobsterai / qoder
  //  三个 oauth 文件里），登录页由客户端 `plugin-src/client/jet-hub.js` 的
  //  `window.open(loginUrl, '_blank', 'width=800,height=600')` 开**一次**，
  //  再被我们的 setWindowOpenHandler 转成系统浏览器 ⇒ 双开问题上游已原生修好。
  //  v1.4.0 的 CI 日志就是证据：`⚠️ 插件补丁未命中 dsh-codearts-auth/lib/jet-hub-rpc.js`
  //  （from 与 to 都不在 ⇒ 目标代码已消失），而功能并没有坏。
  //  如果哪天上游再改回去、或者清单改钉了更早的 ref，看这段注释重新评估要不要补。
  // ── 纯净版（vanilla 分支）说明 ────────────────────────────────────────────
  // 主线里针对各个内置/社区插件的补丁在本分支整体不存在了 —— 因为本分支不装任何
  // 插件。只保留下面三处**内核自带包**的补丁：设置页侧栏滚动、未鉴权模型隐藏、
  // 内核启动提速。它们不引入功能、只修上游缺陷或纯性能改写，属于刻意保留项。
  // 剥离判据与保留清单见 src/main/own-plugins.js 顶部。

  {
    plugin: '@deepseek-ai/dsh-client-ui-settings-general',
    desc: '修复设置中心侧边栏在插件众多时超出视口无法滚动的问题',
    // 根因：官方 SettingsRoot.module.css 里 .VOzbGW_nav 为 flex:none; padding:22px 12px 0;
    // 且没有 min-height:0 与 overflow 设置，.VOzbGW_navList 也没有独立滚动。
    // 在安装数十个插件时，侧栏高度轻松超出 modal 面板高度（min(800px, 100vh - 48px)），
    // 导致下方的大批插件设置入口被 overflow:hidden 强行截断，用户无法滚动查阅。
    // 改法：.VOzbGW_nav 锁定 height:100% + min-height:0 + overflow:hidden；
    // 顶部标题 .VOzbGW_navTitle 设 flex:none 固定；
    // 列表 .VOzbGW_navList 设 flex:1 + min-height:0 + overflow-y:auto，并补充底部 padding:22px。
    edits: [
      {
        file: 'lib/client.js',
        from: '.VOzbGW_nav{box-sizing:border-box;flex-direction:column;flex:none;gap:18px;width:188px;padding:22px 12px 0;display:flex}.VOzbGW_navTitle{color:var(--dsw-alias-label-primary);padding:0 12px;font-size:16px;font-weight:500;line-height:24px}.VOzbGW_navList{flex-direction:column;gap:4px;display:flex}',
        to: '.VOzbGW_nav{box-sizing:border-box;flex-direction:column;flex:none;gap:18px;width:188px;padding:22px 12px 0;display:flex;min-height:0;height:100%;overflow:hidden}.VOzbGW_navTitle{flex:none;color:var(--dsw-alias-label-primary);padding:0 12px;font-size:16px;font-weight:500;line-height:24px}.VOzbGW_navList{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;flex-direction:column;gap:4px;display:flex;padding-bottom:22px}',
      },
    ],
  },
  {
    plugin: '@deepseek-ai/dsh-api-session-controller',
    desc: '默认隐藏未完成鉴权的第三方 provider 的模型（选择器可见性过滤）',
    // ── 问题 ────────────────────────────────────────────────────────────────
    // 模型选择器的目录由**宿主**这段 buildModelCatalog() 组装：它遍历
    // `ctx.llm.listProviders()`，把每个**已注册适配器**的 provider 都变成一个 group。
    // 也就是说，只要插件装上了、适配器注册了，它的模型就会出现在选择器里 ——
    // **与该 provider 是否真的登录过无关**。用户没登录过 trae/grok/gemini/codearts 时，
    // 列表里照样能看到一堆选了也发不出消息的「幽灵模型」。
    //
    // ── 改法 ────────────────────────────────────────────────────────────────
    // 在这里按 provider id 过滤掉「宿主壳判定为未鉴权」的那些 group。名单由 Electron
    // 壳每次启动时算出（src/main/model-visibility.js，依据是本机账号池与凭据文件），
    // 经环境变量 LJANX_HIDDEN_MODELS 传进内核 —— 不读文件、不额外依赖，重启即生效。
    // 三条边界：
    //   · 环境变量为空串时行为与上游**完全一致**（条件里 `__ljanxHidden.size === 0` 短路）；
    //   · 当前默认模型所属的 provider 永远保留，否则选择器会「没有选中项」；
    //   · 只影响选择器可见性。模型目录本就是 advisory（上游注释明写 membership 不控制
    //     路由与校验），设置页的 Models 页仍列出全部 provider 供用户去登录/配 key。
    edits: [
      {
        file: 'lib/index.js',
        fromLines: [
          '\treturn {',
          '\t\tdefault: { ...defaultSelection },',
          '\t\troutableProviders: providers.map((provider) => provider.id),',
          '\t\tgroups: catalog.flatMap((item) => item.kind === "group" ? [item.group] : []).filter((group) => group.models.length > 0),',
        ],
        toLines: [
          '\t// LJANX：默认隐藏「未完成鉴权」的第三方 provider 的模型（名单由宿主壳经',
          '\t// LJANX_HIDDEN_MODELS 传入）。只影响选择器可见性（模型目录本就是 advisory），',
          '\t// 不改路由与请求校验；为空串时行为与上游完全一致；当前默认模型所属 provider',
          '\t// 永远保留，避免选择器出现「没有选中项」。',
          '\tconst __ljanxHidden = new Set(String(process.env.LJANX_HIDDEN_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));',
          '\treturn {',
          '\t\tdefault: { ...defaultSelection },',
          '\t\troutableProviders: providers.map((provider) => provider.id),',
          '\t\tgroups: catalog.flatMap((item) => item.kind === "group" ? [item.group] : []).filter((group) => group.models.length > 0 && (__ljanxHidden.size === 0 || group.id === defaultSelection.provider || !__ljanxHidden.has(group.id))),',
        ],
      },
    ],
  },
  {
    plugin: '@deepseek-ai/dsh-client-modules',
    desc: '内核启动加速：客户端模块组合构建（combo + source map）的纯冗余 CPU',
    // ── 依据（2026-09-20 实测，--cpu-prof 采样内核 web 启动）────────────────
    // 内核每次启动都要把所有插件的 client.js 拼成 combo 脚本 + source map，且每个
    // bundle 被处理两遍（批 combo 一遍 + 单件 combo 一遍），无磁盘缓存。采样显示
    // @deepseek-ai/dsh-client-modules 这一个包占启动 CPU 的 48.7%，其中两个纯浪费点：
    //   · newlineCount（self 21.3%）：逐「码点」迭代数换行（for...of 生成器），
    //     MB 级字符串上极慢 —— 换成 indexOf 原生扫描，语义完全等价（'\n' 不跨码点）；
    //   · identitySectionMap（self 9.8%，并抬高 buildCombo 的 17.2% 与 GC）：
    //     为每一行建一个单元素数组再 join —— 换成 repeat 拼接，输出逐字节相同
    //     （0 行时两边同为空串）。
    // 实测本机 A/B（同一份 dsh-data 副本、同一判据 TCP ready）：上游 7.3/7.3/7.6s
    // → 补丁后 4.5/4.8/4.8s。主进程在 serverManager.start() 前窗口一直停在启动占位页，
    // 所以这 2.8s 是用户看得见的。
    // 不动内核源码包，走补丁通道；两处都是"输出恒等"的纯性能改写，无行为变化，
    // 由 pnpm check:kernelspeed 常驻守着（写法对齐 + 真值逐字节比对）。
    edits: [
      {
        file: 'lib/index.js',
        from: '\tfor (const char of value) if (char === "\\n") count += 1;',
        to: '\tfor (let i = value.indexOf("\\n"); i !== -1; i = value.indexOf("\\n", i + 1)) count += 1;/* LJANX perf: for...of 逐码点迭代 → indexOf 原生扫描，输出等价 */',
      },
      {
        file: 'lib/index.js',
        from: '\tconst mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? "AAAA" : "AACA").join(";");',
        toLines: [
          '\tconst __ljanxLines = newlineCount(source);',
          '\tconst mappings = __ljanxLines === 0 ? "" : "AAAA" + ";AACA".repeat(__ljanxLines - 1);/* LJANX perf: 免去逐行建数组再 join */',
        ],
      },
    ],
  },
]

/**
 * 对一个插件目录套用补丁。
 * @param {string} name 插件名（与 npm 包名一致，可带 scope）
 * @param {string} dir 插件目录（bundle-runtime/plugins/<name> 或 profiles/web/node_modules/<name>）
 * @param {{log: Function, warn: Function}} [log] 日志注入：构建期用 console，宿主用自身日志
 */
export function applyPluginRuntimePatches(name, dir, log = console) {
  // 同一插件可以有多条条目（不同成因分开记）。这里必须用 filter 而不是 find：
  // 用 find 时第二条会静默不生效，是那种"补丁写了但没打上、日志也不报错"的坑。
  const entries = PLUGIN_RUNTIME_PATCHES.filter((it) => it.plugin === name)
  if (entries.length === 0) return
  for (const entry of entries) {
    // ── 快路径（启动速度）────────────────────────────────────────────────
    // 补丁表没变、且所有目标文件的 size+mtimeMs 与上次处理时一致 ⇒ 上次已经处理过，
    // 这次连文件都不读，直接跳过。把「每次启动同步读 1~2MB JS」降成「stat 几个文件」。
    const stamp = readStamp(dir, entry)
    if (stamp.skip) continue

    let applied = 0
    for (const edit of entry.edits) {
      const file = join(dir, edit.file)
      if (!existsSync(file)) {
        log.warn(`  ⚠️ 插件补丁目标文件不存在: ${name}/${edit.file}`)
        continue
      }
      const text = readFileSync(file, 'utf8')
      // 支持 fromLines/toLines：按文件自身行尾拼接（上游文件可能是 CRLF，LF 锚点会全部失配）
      const EOL = text.includes('\r\n') ? '\r\n' : '\n'
      const from = edit.fromLines ? edit.fromLines.join(EOL) : edit.from
      const to = edit.toLines ? edit.toLines.join(EOL) : edit.to
      if (from === undefined || to === undefined) {
        log.warn(`  ⚠️ 插件补丁缺少 from/to: ${name}/${edit.file}`)
        continue
      }
      if (text.includes(to)) continue // 幂等
      if (!text.includes(from)) {
        log.warn(
          `  ⚠️ 插件补丁未命中（上游结构可能已变）: ${name}/${edit.file} ← ${JSON.stringify(from.slice(0, 48))}`,
        )
        continue
      }
      writeFileSync(file, text.replaceAll(from, to))
      applied += 1
    }
    if (applied > 0) {
      log.log(`  🔧 插件兼容补丁（${applied} 处）: ${name}（${entry.desc ?? '兼容修复'}）`)
    }
    // 记下本次处理后的文件指纹，下次启动即可跳过（写不进去也无妨）。
    const files = {}
    let fingerprintOk = true
    for (const edit of entry.edits) {
      const fp = fileFingerprint(dir, edit.file)
      if (fp === null) {
        fingerprintOk = false
        break
      }
      files[edit.file] = fp
    }
    if (fingerprintOk) writeStamp(dir, stamp.sig, files)
  }
}

/**
 * 对一个 profile 的 node_modules 批量套用兼容补丁（宿主侧入口）。
 *
 * 内置插件不必重复处理：它们在构建期就已打过补丁，而 profile 里的条目只是指向
 * App 包内 runtime/plugins/<name> 的链接，再打一遍只会去写安装目录。
 *
 * @param {string} nodeModulesDir <DSH_HOME>/profiles/web/node_modules
 * @param {{skip?: Iterable<string>, log?: {log: Function, warn: Function}}} [opts]
 * @returns {string[]} 实际发生改动的插件名
 */
export function applyCompatPatchesToTree(nodeModulesDir, opts = {}) {
  const { skip = [], log = console } = opts
  const skipSet = new Set(skip)
  const touched = []
  if (!existsSync(nodeModulesDir)) return touched
  for (const entry of PLUGIN_RUNTIME_PATCHES) {
    if (skipSet.has(entry.plugin)) continue
    const dir = join(nodeModulesDir, ...entry.plugin.split('/'))
    if (!existsSync(join(dir, 'package.json'))) continue // 该插件未安装，属正常情况
    // 戳记命中 ⇒ 已经处理过且文件没变：连 countPatched 的两次读都省掉
    // （启动期这几 MB 的同步读全在主线程上，正是要削的东西）。
    if (readStamp(dir, entry).skip) continue
    const before = countPatched(dir, entry)
    applyPluginRuntimePatches(entry.plugin, dir, log)
    if (countPatched(dir, entry) > before) touched.push(entry.plugin)
  }
  return touched
}

/** 该插件当前已有多少处补丁处于「已打完」状态，用于判断是否真的发生了改动。 */
function countPatched(dir, entry) {
  let n = 0
  for (const edit of entry.edits) {
    const file = join(dir, edit.file)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const to = edit.toLines ? edit.toLines.join(eol) : edit.to
    if (to && text.includes(to)) n += 1
  }
  return n
}
