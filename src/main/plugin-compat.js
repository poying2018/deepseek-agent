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
  {
    plugin: 'dsh-codearts-auth',
    desc: '登录只开一个系统浏览器（抑制宿主那一次重复打开）',
    // ── 为什么要抑制宿主那次打开 ────────────────────────────────────────────
    // 该插件三个 provider 里有两条登录路径：
    //   · buddy / workbuddy —— 宿主流程**已经**传 `openBrowser: () => {}`，
    //     只靠客户端 `window.open(loginUrl)` 开一次（主进程会把它转成系统浏览器）；
    //   · codearts / lobsterai —— 宿主 `startLogin()` 内部默认**自己再开一次**
    //     （lib/login.js: `options.openBrowser ?? openBrowser`），而客户端同样会
    //     `window.open` 一次 ⇒ 系统浏览器被打开**两个**标签页。
    // 用户在其中「先点到」的那一个里完成授权时，回调可能落在另一个流程的 state 上，
    // 于是轮询永远等不到 done，界面停在「等待授权」——表现为「CodeArts 用不了」。
    // 改法：给 codearts / lobsterai 的宿主 startLogin 传空 opener，让打开登录页这件事
    // 完全由客户端负责（客户端那次仍会被主进程 setWindowOpenHandler 转成系统浏览器）。
    //
    // ⚠️ 这条锚点已经来回跳过一次（2026-09-20 再修）：
    //   · 最早锚 `codearts.login({ refName, accountId: id, pool })`（阻塞式）；
    //   · 上游改成两步式 `startLogin()`（先拿 loginUrl 立即返回、后台等回调）后旧锚点
    //     匹配不到，补丁静默空转 ⇒ 双浏览器复发、CodeArts 卡在「等待授权」；
    //   · 2026-09-19 重新锚到 startLogin；
    //   · 上游 be6ba1c 之后又回成 `login()`，并新增 `lib/service.js:48 login()` →
    //     `runOAuthFlow()` → `options.openBrowser ?? openBrowser`（宿主自己开），
    //     而 jet-hub-rpc.js 调用处不传 opener、同时把 loginUrl 交给客户端开
    //     ⇒ 再次双开。同文件 buddy 路径上游已经自己写了 `openBrowser: () => { }`，
    //     只有 codearts 这条是漏网的。
    // 教训：这类"上游重构导致补丁静默失效"靠人记不住，所以 `pnpm check:patches`
    // 会把补丁表里每一处 to 文本对着暂存产物逐条断言，失效即门禁失败。
    // 上游若把这件事原生修好（像 buddy 那样），to 文本会不在 ⇒ 门禁报错，届时删掉本条即可。
    edits: [
      {
        file: 'lib/jet-hub-rpc.js',
        from: 'const loginResult = await codearts.login({ refName, accountId: id, pool });',
        to: 'const loginResult = await codearts.login({ refName, accountId: id, pool, openBrowser: () => { } });/* LJANX: 登录页交给客户端开一次，宿主不再重复开 */',
      },
    ],
  },
  {
    plugin: 'dsh-codearts-auth',
    desc: 'benefit（免费额度）头口径变了的自愈重试：修「codearts: benefit not found」',
    // ── 报错现场 ────────────────────────────────────────────────────────────
    // 用户报「本轮运行失败 codearts: benefit not found」。该字符串**不在插件代码里**，
    // 是 CodeArts 后端在 HTTP 200 的 SSE 流里回的 `error_msg`；适配器在
    // llm-adapter.js 的 consumeSse 里检测到 error_code 后原样抛出：
    //     throw new LlmError(`codearts: ${message}`, 'INVALID_REQUEST', { status: 200 })
    // 于是 UI 上就是 `codearts: benefit not found`。
    //
    // ── 成因 ────────────────────────────────────────────────────────────────
    // 后端有一类「benefit（免费额度）」模型：chat 请求**必须**带 `maas_type: benefit`
    // 请求头并参与 HMAC 签名，否则拒绝。而插件把这个名单**硬编码**成只有
    // `glm-5.3-flash`（见 MAAS_TYPE_BENEFIT_MODELS，注释写于 2026-08）。
    // 但同一个文件开头还写着 deepseek-v4-flash 是「每日 1000 万免费 Tokens **福利**」
    // 模型（福利 = benefit），而它**不在**那张表里 ⇒ 若后端已把 deepseek-v4-flash
    // 也改成 benefit 口径，请求就会因为「没有声明 benefit」而失败；反过来，若账号侧
    // 的 benefit 额度失效，带着该头的 glm-5.3-flash 同样会失败。
    // 两种情形都会走到同一个错误文案，仅凭消息无法区分。
    //
    // ── 实测结论（2026-09-19，用插件自己的 sign.js 直连后端验证）────────────
    // 对同一个账号各发两次最小请求，结果非常明确：
    //   · deepseek-v4-flash  不带 maas_type → HTTP 200 正常出流 ✅
    //                        带 maas_type   → HTTP 200 + error_msg「benefit not found」❌
    //   · glm-5.3-flash      不带 maas_type → InferHub.002002009.404「model is not registered」❌
    //                        带 maas_type   → 被接受（当时撞到 TM.00001041 并发上限）
    // 也就是说**插件原本的名单方向是对的**：`glm-5.3-flash` 是 benefit 模型、必须带头；
    // `deepseek-v4-flash` 不是，带头反而会被拒。⚠️ 因此**不要**把 deepseek-v4-* 加进这张表
    // （试过，实测会把它直接打坏）。
    //
    // 那 `codearts: benefit not found` 是怎么来的：后端在「带着 benefit 头、但不是
    // benefit 模型的请求」上回这个错。也就是说报错那条请求用的是 glm-5.3-flash 一类的
    // benefit 模型，而后端此刻不认这份 benefit 权益（额度/并发/活动状态）。
    // 这属于账号侧状态，代码改不了 —— 我们能做的是**别让它变成一句没有出路的报错**。
    //
    // ── 改法：只加一层自愈 + 把话说清楚（不动名单）─────────────────────────
    // 命中 benefit 语义的错误时，抛可重试信号，由外层把 `maas_type` 头取反重试一次：
    //   · 名单正确时这条路径永不触发 ⇒ 正常请求零影响；
    //   · 后端将来真的改口径（把某个模型在 benefit/非 benefit 之间挪），它能自动适应；
    //   · 两次都失败时抛出带模型名与建议的错误，而不是光秃秃一行 `benefit not found`。
    edits: [
      {
        // ① 新增专用的可重试错误类型（外层 catch 据此区分「切换 benefit 头」与排队重试）
        file: 'lib/llm-adapter.js',
        fromLines: [
          'class SseQueueRetryError extends Error {',
          '    code;',
          '    constructor(code, message) {',
          '        super(message);',
          "        this.name = 'SseQueueRetryError';",
          '        this.code = code;',
          '    }',
          '}',
        ],
        toLines: [
          'class SseQueueRetryError extends Error {',
          '    code;',
          '    constructor(code, message) {',
          '        super(message);',
          "        this.name = 'SseQueueRetryError';",
          '        this.code = code;',
          '    }',
          '}',
          '/**',
          ' * LJANX：后端以「benefit」语义拒绝请求时抛出的可重试信号。',
          ' * 外层重试循环据此把 `maas_type: benefit` 头**取反**再试一次（只一次）。',
          ' * 为什么不在代码里维护 benefit 模型名单：名单在后端手里、会变，猜错会主动',
          ' * 把本来能用的模型打坏；让请求自适应则两条口径都能走通。',
          ' */',
          'class SseBenefitRetryError extends Error {',
          '    code;',
          '    constructor(code, message) {',
          '        super(message);',
          "        this.name = 'SseBenefitRetryError';",
          '        this.code = code;',
          '    }',
          '}',
        ],
      },
      {
        // ② 外层重试循环前声明「benefit 头是否取反」
        file: 'lib/llm-adapter.js',
        fromLines: [
          '        for (;;) {',
          '            // glm-5.3-flash 是 benefit（免费额度）模型，后端要求 maas_type: benefit',
        ],
        toLines: [
          '        // LJANX：0 = 用插件内置表判断要不要 benefit 头；1 = 取反重试（仅一次）。',
          '        let __ljanxBenefitFlip = 0;',
          '        for (;;) {',
          '            // glm-5.3-flash 是 benefit（免费额度）模型，后端要求 maas_type: benefit',
        ],
      },
      {
        // ③ 按「内置表 XOR 取反标记」决定这一次请求带不带 maas_type
        file: 'lib/llm-adapter.js',
        from: "            const extraSignedHeaders = MAAS_TYPE_BENEFIT_MODELS.has(options.model) ? { maas_type: 'benefit' } : undefined;",
        toLines: [
          '            // LJANX：__ljanxBenefitFlip 为 1 时取反（见 SseBenefitRetryError 的说明）。',
          '            const __ljanxWantBenefit = MAAS_TYPE_BENEFIT_MODELS.has(options.model) !== (__ljanxBenefitFlip === 1);',
          "            const extraSignedHeaders = __ljanxWantBenefit ? { maas_type: 'benefit' } : undefined;",
        ],
      },
      {
        // ④ SSE 内嵌错误：benefit 语义 → 抛可重试信号（而不是直接终止本轮）
        file: 'lib/llm-adapter.js',
        from: "                        throw new LlmError(`codearts: ${message}`, 'INVALID_REQUEST', { status: 200 });",
        toLines: [
          '                        // LJANX：benefit 语义的错误交给外层切换 maas_type 头重试一次',
          '                        // （后端对「这个模型要不要 benefit 头」的口径会变，代码里不猜）。',
          '                        if (/benefit/i.test(message) || /benefit/i.test(String(data.error_code))) {',
          '                            throw new SseBenefitRetryError(data.error_code, message);',
          '                        }',
          "                        throw new LlmError(`codearts: ${message}`, 'INVALID_REQUEST', { status: 200 });",
        ],
      },
      {
        // ⑤ 消费 SSE 的 catch：处理切换重试，并把二次失败翻译成可行动的说明
        file: 'lib/llm-adapter.js',
        fromLines: [
          '                catch (error) {',
          '                    if (!(error instanceof SseQueueRetryError))',
          '                        throw error;',
          '                    // 落入下方排队重试',
          '                }',
        ],
        toLines: [
          '                catch (error) {',
          '                    // LJANX：benefit 口径失败 → 取反 maas_type 头重试一次；',
          '                    // 仍然失败则说明该模型确实不可用（额度/权益问题），给出可行动的说明。',
          '                    if (error instanceof SseBenefitRetryError) {',
          '                        if (__ljanxBenefitFlip === 1) {',
          '                            throw new LlmError(',
          '                                `codearts: 模型 ${options.model} 不可用（${error.message}）——已自动切换 maas_type: benefit 头重试仍失败；`',
          '                                + `该模型可能已不在你账号的 CodeArts 免费额度内，请在 CodeArts 侧确认权益，或换用其它模型（如 deepseek-v4-flash）。`,',
          "                                'INVALID_REQUEST',",
          '                                { status: 200 },',
          '                            );',
          '                        }',
          '                        __ljanxBenefitFlip = 1;',
          '                        continue;',
          '                    }',
          '                    if (!(error instanceof SseQueueRetryError))',
          '                        throw error;',
          '                    // 落入下方排队重试',
          '                }',
        ],
      },
    ],
  },
  {
    plugin: 'dsh-plugin-dashboard',
    desc: '版本号读取兼容新旧品牌命名（否则回退成 0.1.2-rc.1）',
    // 品牌改名（jackdsh → ljanx）遗留：该插件读旧环境变量名 JACKDSH_VERSION、
    // 并按 `parsed.name === 'jackdsh'` 认宿主的 package.json。改名后三层读取全落空，
    // 最终回退到硬编码的 '0.1.2-rc.1'——用户看到「版本号变回了旧值」。
    // 这里让插件同时认新旧两套命名（宿主侧也保留了旧环境变量别名做双保险）。
    edits: [
      {
        file: 'dashboard.js',
        from: 'if (process.env.JACKDSH_VERSION) return process.env.JACKDSH_VERSION',
        to: 'if (process.env.LJANX_VERSION ?? process.env.JACKDSH_VERSION) return (process.env.LJANX_VERSION ?? process.env.JACKDSH_VERSION)',
      },
      {
        file: 'dashboard.js',
        from: "if (parsed.name === 'jackdsh' && parsed.version) return parsed.version",
        to: "if ((parsed.name === 'ljanx' || parsed.name === 'jackdsh') && parsed.version) return parsed.version",
      },
    ],
  },
  {
    plugin: '@mlgbnb/dsh-archive-manager',
    desc: '归档列表改用隔离数据目录，并兼容 0.1.5 的分目录投影缓存与 v3 会话日志名',
    // 「设置页里归档的对话不显示」的四处根因（逐个实测，见下面每条的注释）：
    //  ① 插件把数据目录硬编码成 `~/.dsh`，完全忽略本发行版为内核设置的隔离 DSH_HOME
    //     （%APPDATA%\\ljanx\\dsh-data）→ 读到的是遗留的旧数据/读不到归档列表；
    //  ② 它只认旧的单文件投影缓存 storages/session_projcache.json，而内核 0.1.5 起
    //     已改成目录形式 storages/session_projcache/sessions/<id>.json（记录结构一致）；
    //  ③ 上一版补丁把 ② 写成了「聚合表非空就整份返回」的两选一，而聚合表只覆盖**部分**
    //     会话（实测：22 个会话目录里只有 12 个在聚合表有行，且 6 个 `session-<uuid>`
    //     命名的新会话一个都不在）→ 另一半仍然查不到行；
    //  ④ 它把会话日志文件名写死成 session.jsonl.zstd / session.jsonl，而现行内核落盘是
    //     **session.v3.jsonl.zstd**（实测 22/22 全部如此）→ hasDataFile 恒为 false。
    // ③+④ 合起来才是真正致命的：listArchives 的 ghost 判定是
    // 「没有数据文件 && 没有投影缓存行」，两条同时成立 → 它把该 id 从 workspace.json 的
    // global.archivedSessionIds 里**写回删除**。于是用户归档一个会话，只要打开过一次归档
    // 管理卡片，归档状态就被静默抹掉，侧边栏也跟着恢复显示 —— 表现就是"归档不显示"。
    // 所以这里除了让它认得 v3 文件名、把两个缓存来源合并，还把 ghost 收紧成
    // 「连会话目录都没有」才剪，避免插件继续改内核的存档。
    edits: [
      {
        file: 'lib/index.js',
        from: "  return join(homedir(), '.dsh')",
        to: "  const envHome = process.env.DSH_HOME ?? process.env.JACKDSH_HOME; return envHome && String(envHome).trim() ? String(envHome).trim() : join(homedir(), '.dsh')",
      },
      {
        file: 'lib/index.js',
        from: '/** Path to session_projcache.json. */',
        to: [
          '/** 兼容读取投影缓存：分目录 sessions/<id>.json 与单文件聚合表**都要读**并合并。 */',
          'export function readProjcacheCompat() {',
          "  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')",
          '  const sessions = {}',
          '  try {',
          '    for (const entry of readdirSync(dir)) {',
          "      if (!entry.endsWith('.json')) continue",
          '      const parsed = readJsonFile(join(dir, entry))',
          '      const record = parsed?.record ?? parsed',
          "      if (record) sessions[entry.replace(/\\.json$/, '')] = record",
          '    }',
          '  } catch {}',
          '  const legacy = readJsonFile(projcachePath())',
          '  if (legacy?.tables?.sessions) Object.assign(sessions, legacy.tables.sessions)',
          '  return { tables: { sessions } }',
          '}',
          '',
          '/** Path to session_projcache.json. */',
        ].join('\n'),
      },
      {
        // 会话日志文件名解析器：内核换过 v1→v2→v3 的落盘名，写死任何一个都会在升轨后
        // 静默失配（而且失配方向是"误删用户的归档状态"，不是少显示几行）。
        file: 'lib/index.js',
        from: '/** Read full transcript text from data directory. */',
        to: [
          '/**',
          '* 按目录实际内容找会话日志：现行内核是 session.v3.jsonl.zstd，',
          '* 历史还有 session.jsonl.zstd / session.jsonl。返回绝对路径，缺位给空串',
          '* （空串过 existsSync 恒为 false，调用方无需改动判断）。',
          '*/',
          'export function findSessionLogs(dataDir) {',
          '  const out = { zstd: \'\', jsonl: \'\' }',
          '  try {',
          '    const names = readdirSync(dataDir)',
          "    const zstd = names.find((n) => n.startsWith('session') && n.endsWith('.jsonl.zstd'))",
          "    const plain = names.find((n) => n.startsWith('session') && n.endsWith('.jsonl'))",
          "    if (zstd) out.zstd = join(dataDir, zstd)",
          "    else if (plain) out.jsonl = join(dataDir, plain)",
          '  } catch {}',
          '  return out',
          '}',
          '',
          '/** Read full transcript text from data directory. */',
        ].join('\n'),
      },
      {
        file: 'lib/index.js',
        from: [
          'export function readTranscriptText(dataDir) {',
          "  const zstdPath = join(dataDir, 'session.jsonl.zstd')",
          "  const jsonlPath = join(dataDir, 'session.jsonl')",
        ].join('\n'),
        to: [
          'export function readTranscriptText(dataDir) {',
          '  const logs = findSessionLogs(dataDir)',
          '  const zstdPath = logs.zstd',
          '  const jsonlPath = logs.jsonl',
        ].join('\n'),
      },
      {
        file: 'lib/index.js',
        from: [
          "      const zstdPath = join(dataDir, 'session.jsonl.zstd')",
          "      const jsonlPath = join(dataDir, 'session.jsonl')",
          '      hasDataFile = existsSync(zstdPath) || existsSync(jsonlPath)',
        ].join('\n'),
        to: [
          '      const logs = findSessionLogs(dataDir)',
          "      hasDataFile = logs.zstd !== '' || logs.jsonl !== ''",
        ].join('\n'),
      },
      {
        // ghost 只能意味着"这个 id 在磁盘上彻底没有痕迹"。用目录是否存在判定，而不是
        // 有没有读到数据文件 —— 后者依赖文件名猜对，猜错的代价是删掉用户的归档状态。
        file: 'lib/index.js',
        from: '    if (!hasDataFile && !sessionMeta) {',
        to: '    if (dataDir === undefined && !sessionMeta) {',
      },
      {
        // 让上面那个兼容读取器真的被用上（两处调用点：列表与详情）。
        file: 'lib/index.js',
        from: 'const projcache = readJsonFile(projcachePath())',
        to: 'const projcache = readProjcacheCompat()',
      },
    ],
  },
  {
    plugin: 'dsh-web-search-follow',
    desc: '未适配模型回退 DeepSeek 官方搜索；凭据路径优先隔离 DSH_HOME',
    // 「新加的（web 搜索）插件用不了」的两个根因：
    //  ① follow-search 只适配 Grok / Gemini / DeepSeek 三种模型路由，其它模型
    //     （workbuddy / trae / codebuddy / codearts…）一律抛
    //     `provider "xxx" has no native search adapter yet` → 这些模型下 web_search
    //     完全不可用。改为回退到 DeepSeek 官方搜索：用用户自己的 DEEPSEEK_API_KEY、
    //     DeepSeek 侧默认模型，与当前聊天模型无关，也不动其它服务商的额度。
    //  ② deepseek.js 的凭据回退路径硬编码 ~/.dsh，忽略本发行版给内核设的隔离
    //     DSH_HOME（与新版凭据存储格式也不匹配）。
    edits: [
      {
        file: 'index.js',
        fromLines: [
          '      // 未适配的其它模型：坚决报错，不跨服务商乱回退/漏金',
          '      throw new Error(unsupportedRouteMessage(route));',
        ],
        toLines: [
          '      // 未适配的其它模型（workbuddy / trae / codebuddy 等）：回退到 DeepSeek 官方搜索',
          '      // （用用户自己的 DEEPSEEK_API_KEY；模型走 DeepSeek 侧默认值，与当前聊天模型无关）。',
          '      // 原实现是「坚决报错、不跨服务商回退」，但那样换上这几个模型就完全不能用联网搜索；',
          '      // 改成回退，仍不触碰其它服务商的额度。',
          '      try {',
          '        const result = await executeDeepSeekSearch(ctx, query, {',
          '          maxResults: request.maxResults,',
          '          signal,',
          '        });',
          '        return {',
          '          sources: Array.isArray(result?.sources) ? result.sources : [],',
          '          truncated: result?.truncated === true,',
          '        };',
          '      } catch (error) {',
          '        if (isNoSourcesError(error)) return { sources: [], truncated: false };',
          '        throw error;',
          '      }',
        ],
      },
      {
        file: 'deepseek.js',
        from: '    const credPath = join(homedir(), ".dsh", ".credentials.yaml");',
        to: '    const envHome = process.env.DSH_HOME ?? process.env.JACKDSH_HOME; const baseDir = envHome && String(envHome).trim() ? String(envHome).trim() : join(homedir(), ".dsh"); const credPath = join(baseDir, ".credentials.yaml");',
      },
    ],
  },
  {
    plugin: 'dsh-skin-manager',
    desc: '死引用改指后继 seed 模块，避免整壳白屏',
    // 该插件 0.1.6（2026-08-19 后未再发版）在客户端 bundle 里硬 require
    // `@deepseek-ai/dsh-client-runtime/client`。平台自 0.1.2-alpha.1 起把
    // dsh-client-runtime 拆成 dsh-client-modules / dsh-client-store / dsh-client-locale，
    // 并冻结了 seed 表（见作者仓库 issue #41），该说明符在现行内核里**无解**。
    // 而 loader 查表是「原始 spec 先查 seed，未命中才 stripClientSuffix 查 factories」，
    // 所以 `x/client` 子路径不会回落到 `x` —— 必然抛 missed the module table。
    // 后果不止这一个插件：任一 loader entry 导入失败会**中止整个 web 壳启动**
    // （用户看到满屏 "Failed to load plugins"），所以皮肤管理器自己崩会带走皮肤插件
    // 和会话界面一起白屏。
    // 实测：`_runtime_client` 在它的 lib/client.js 里只出现 1 次（赋值后从未被使用），
    // 是上游构建残留的死引用 ⇒ 改指后继 seed 模块即可，零语义风险。
    edits: [
      {
        file: 'lib/client.js',
        from: 'let _runtime_client = require("@deepseek-ai/dsh-client-runtime/client");',
        to: 'let _runtime_client = require("@deepseek-ai/dsh-client-store");/* LJANX 兼容：dsh-client-runtime 已从平台 seed 表移除，改指其后继 dsh-client-store（该变量在本插件中从未被使用） */',
      },
    ],
  },
  {
    plugin: 'dsh-plugin-dashboard',
    desc: '底栏不再注入版本号胶囊（宽度实测不够），tooltip 改用对外品牌名',
    // 这个胶囊原本挂在「设置」按钮内部 label 之后。2026-09-19 在真实页面里量过：
    //   _footArea（被 dsh-web-restart 的宽模式改成一行）总宽 207px
    //   _footerActions 是 flex:none，四个 36px 图标固定吃掉 144px
    //   _settingsArea 是 flex:1 1 auto，只剩 63px；按钮内部是 [齿轮 15px][gap 8][设置]
    // 也就是说这一行**没有**放版本号胶囊的余量，四种放法都实测过、都坏：
    //   ① 留在按钮里 → 宽度不足时先裁掉徽标尾字符（显示成 "v1.3"）；
    //   ② overflow:visible → 直接溢出压到旁边的重启图标；
    //   ③ 搬进 _footerActions 当独立 flex 项 → 144 变 ~200，把 flex:1 的设置区挤到
    //      几乎不可点击；
    //   ④ 按钮改 flex-direction:column 纵向堆叠 → 尺寸不变，但会把齿轮图标一起堆起来。
    // 结论：底栏不放版本号。版本仍可在 tooltip 和插件面板里看（tooltip 顺带改成对外
    // 品牌名，替换掉残留的旧品牌字样 JackDSH —— 只是显示文案，宿主侧
    // JACKDSH_VERSION 环境变量双写别名不受影响）。
    edits: [
      {
        file: 'client.js',
        fromLines: [
          "          const label = trigger.querySelector('[class*=\"_triggerLabel\"]')",
          '          if (label) {',
        ],
        toLines: [
          '          // LJANX：底栏宽度实测不够放版本号胶囊（四种放法都会挤坏布局，成因见补丁表注释），',
          '          // 所以这里不再注入；版本号见按钮 tooltip 与插件面板。label 置空即整段跳过。',
          '          const label = null',
          '          if (label) {',
        ],
      },
      {
        file: 'client.js',
        from: '          const fullTitle = `设置 · JackDSH v${cachedJackDshVersion}`',
        to: '          const fullTitle = `设置 · DeepSeek Agent v${cachedJackDshVersion}`',
      },
    ],
  },
  {
    plugin: 'dsh-web-restart',
    desc: '撤掉「底栏压成一行」的改造，回到官方上下两行布局',
    // 该插件在 slot 收到 wide=true（侧栏展开）时，用 :has(.dwr-wide) 把 _footArea 从官方的
    // 上下两行改成一行：设置区 flex:1 1 auto + 图标行 flex:none。
    // 2026-09-19 在真实页面量过这一行的账：_footArea 可用宽 207px，四个 36px 图标固定吃掉
    // 144px，而设置按钮自然宽约 77px（[齿轮15][gap8][「设置」≈28][左右 padding18]）——
    // 合计 221px，差 14px。因为设置区是 min-width:0，被压的是它：实测只剩 63px，
    // 「设置」两个字直接溢出到图标底下（用户报的"还是有遮挡"）。
    // 撤掉这三条就恢复官方两行：上行「⚙ 设置」整行宽 207px 绰绰有余，下行四个图标。
    // 侧栏底部因此高约 36px，换来文字不再被压。
    edits: [
      {
        file: 'client.js',
        fromLines: [
          "      '[class*=\"_footArea\"]:has(.dwr-wide){flex-direction:row;align-items:center;gap:4px}',",
          "      '[class*=\"_footArea\"]:has(.dwr-wide) [class*=\"_settingsArea\"]{flex:1 1 auto;width:auto;min-width:0}',",
          "      '[class*=\"_footArea\"]:has(.dwr-wide) [class*=\"_footerActions\"]{order:2;flex:none;width:auto;align-items:center;justify-content:flex-end}',",
        ],
        toLines: [
          '      // LJANX：这里原本有三条 :has(.dwr-wide) 规则把底栏压成一行，已撤掉。',
          '      // 一行放不下「齿轮+设置」加四个图标（207px 可用 / 需要 221px），会把「设置」',
          '      // 文字挤到图标底下。恢复官方上下两行布局，成因与实测数字见补丁表注释。',
        ],
      },
    ],
  },
  {
    plugin: 'dsh-mobile-plus',
    desc: '停用「底栏压成一行」的三条改造（与 dsh-web-restart 同一套，撤一个不够）',
    // 侧栏底栏被压成一行是**三个插件各自**做的：dsh-web-restart(.dwr-wide)、
    // dsh-mobile-plus(.mp-trigger-wide)、dsh-update-check(.duc-wide，仓内自带，已在源码里撤)。
    // :has() 只要有一条命中就塌成一行，所以只撤 dsh-web-restart 时用户看到的还是原样。
    // 一行的账（展开态实测）：_footArea 可用 207px，四个 36px 图标 144px，
    // 「齿轮+设置」按钮自然宽约 77px ⇒ 需要 221px，被 min-width:0 压扁的是设置区
    // （只剩 63px），「设置」字样溢出到图标底下。
    // 这个插件的 CSS 是**一整行字符串**，三条规则不是三行源码，没法按行删；
    // 所以改选择器让它永不命中（类名照旧挂，规则空转）。
    // ⚠️ 不能用空串替换：执行器的幂等判断是 text.includes(to)，to='' 恒为真会直接跳过补丁。
    edits: [
      {
        file: 'client.js',
        from: '[class*=\\"_footArea\\"]:has(.mp-trigger-wide)',
        to: '[class*=\\"_footArea\\"]:has(.mp-trigger-wide-off)',
      },
    ],
  },
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
    plugin: 'dsh-client-ui-seaglass',
    desc: 'GPU 友好默认：降低玻璃模糊半径、关掉纯装饰性常驻动画',
    // ── 为什么这是「主题插件 GPU 过高」的主因 ────────────────────────────────
    // 这个主题把整块界面做成磨砂玻璃：每张卡片 / 气泡 / 输入栏都用
    // `backdrop-filter: blur(var(--dsh-aqua-blur))`，默认 store 里 blur = 20px。
    // 背后又是一层**全屏动画**（流体 canvas 30fps + 环境层不透明度呼吸 + 水母/气泡/
    // 浮游生物五组 infinite 动画）。backdrop-filter 必须对「它下面每一帧的内容」
    // 重新采样，所以「大面积 blur × 一直在动的背景」是集成显卡上最贵的一种组合：
    // 每帧都要重做整屏高斯模糊，GPU 占用自然居高不下。
    //
    // 三处改动，都只动「默认值」，用户在设置页里改过的值不受影响：
    //  ① blur 20 → 12：与 CSS 里的 fallback 值（14）大致对齐，观感几乎不变，
    //     但高斯模糊的采样成本大致按半径平方下降；
    //  ② critters 默认关：水母/气泡/浮游生物是五组 **infinite** 的 transform/opacity
    //     常驻动画，纯装饰、不承载信息，却是永不停止的合成负担；
    //  ③ 环境层（[data-dsh-aqua-ambient]，position:fixed; inset:0）的 `breathe`
    //     动画改为 none：在**全屏图层**上做不透明度渐变的代价是整屏重绘，
    //     而它的视觉收益只有 0.86→1 的轻微呼吸感。
    // 想要原来的观感，把设置页里对应滑块调回去即可。
    edits: [
      {
        // store 初值（用户没改过时的取值）
        file: 'lib/client.js',
        fromLines: ['\t\t\tblur: 20,', '\t\t\tfrost: 7,'],
        toLines: ['\t\t\tblur: 12,/* LJANX GPU：20→12，降低 backdrop-filter 采样成本 */', '\t\t\tfrost: 7,'],
      },
      {
        file: 'lib/client.js',
        fromLines: ['\t\t\tcritters: true,'],
        toLines: ['\t\t\tcritters: false,/* LJANX GPU：水母/气泡/浮游生物为纯装饰常驻动画，默认关 */'],
      },
      {
        // 设置页读的默认表（与 store 初值必须一致，否则「恢复默认」会把 blur 抬回 20）
        file: 'lib/client.js',
        fromLines: ['const SETTINGS_DEFAULTS = {', '\tmode: "mica",', '\tblur: 20,'],
        toLines: ['const SETTINGS_DEFAULTS = {', '\tmode: "mica",', '\tblur: 12,'],
      },
      {
        file: 'lib/client.js',
        fromLines: ['\twhale: true,', '\tcritters: true,'],
        toLines: ['\twhale: true,', '\tcritters: false,'],
      },
      {
        file: 'lib/client.js',
        from: 'animation: dsh-aqua-breathe 9s var(--ds-ease-in-out) infinite alternate;',
        to: 'animation: none;/* LJANX GPU：全屏环境层的不透明度动画会让合成器逐帧重绘整屏 */',
      },
    ],
  },
  {
    plugin: 'dsh-dream-skin',
    desc: 'GPU 友好默认：玻璃模糊半径 14 → 10',
    // 同 seaglass 的成因：玻璃卡片全部走 `filter/backdrop-filter: blur()`，默认半径 14。
    // 这个插件没有常驻动画，开销集中在「大面积模糊 × 滚动/流式输出时背景在变」，
    // 因此只把半径收到 10（仍在"磨砂"范围内，观感差异很小）。
    // 这是 DEFAULT_* 常量，用户在设置页里调过的值存在 localStorage，不受影响。
    edits: [
      {
        file: 'lib/client.js',
        from: 'const DEFAULT_GLASS_BLUR = 14;',
        to: 'const DEFAULT_GLASS_BLUR = 10;/* LJANX GPU：14→10，降低大面积 backdrop-filter 的采样成本 */',
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
