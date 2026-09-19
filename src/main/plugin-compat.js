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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 逐插件的兼容补丁清单。每条 edits 是一次「行内字符串整段替换」，
 * 锚点必须带上相邻注释以保证唯一（单行锚点在压缩过的上游文件里常出现多次）。
 */
export const PLUGIN_RUNTIME_PATCHES = [
  {
    plugin: 'dsh-codearts-auth',
    desc: '登录统一走系统浏览器，不再开应用内窗口',
    // 「登录时同时弹出两个浏览器」的两处根因：
    //  ① 客户端 lib/client/jet-hub.js 用 window.open(loginUrl) 开登录页。宿主主进程的
    //     windowOpenHandler 会把 https 转给系统浏览器并拒绝应用内窗口 → window.open
    //     返回空 → 插件随后 `window.location.href = loginUrl` 兜底，把**应用主窗口**整页
    //     导航成第三方登录页（用户看到「应用里又弹了个浏览器」）。
    //  ② codearts 的宿主登录流程（lib/login.js）自己也会用系统浏览器打开一次，而客户端
    //     还会再开一次 → 系统浏览器两个标签页。（buddy/workbuddy 的宿主传的是空 opener，
    //     只靠客户端开，所以不能无脑删客户端的 window.open。）
    // 改法：客户端不再导航主窗口；宿主那一次让给客户端统一开（客户端那次也会被主进程
    // 转成系统浏览器），于是任何 provider 都恰好只开一个系统浏览器。
    edits: [
      {
        file: 'lib/client/jet-hub.js',
        from: 'window.location.href = loginUrl;',
        to: 'void 0;/* LJANX: 不把应用窗口导航成登录页，登录页统一交给系统浏览器 */',
      },
      {
        file: 'lib/jet-hub-rpc.js',
        from: 'const loginResult = await codearts.login({ refName, accountId: id, pool });',
        to: 'const loginResult = await codearts.login({ refName, accountId: id, pool, openBrowser: () => { } });',
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
    desc: '归档列表/详情改用隔离数据目录，并兼容 0.1.5 的分目录投影缓存',
    // 「已归档的会话无法正常显示」的两处根因：
    //  ① 插件把数据目录硬编码成 `~/.dsh`，完全忽略本发行版为内核设置的隔离 DSH_HOME
    //     （%APPDATA%\\ljanx\\dsh-data）→ 读到的是遗留的旧数据/读不到归档列表；
    //  ② 它只认旧的单文件投影缓存 storages/session_projcache.json，而内核 0.1.5 起
    //     已改成目录形式 storages/session_projcache/sessions/<id>.json（记录结构一致）。
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
          '/** 兼容读取投影缓存：内核 0.1.5 起存成分目录 sessions/<id>.json，旧版是单文件。 */',
          'export function readProjcacheCompat() {',
          '  const legacy = readJsonFile(projcachePath())',
          '  if (legacy?.tables?.sessions && Object.keys(legacy.tables.sessions).length > 0) return legacy',
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
          '  return { tables: { sessions } }',
          '}',
          '',
          '/** Path to session_projcache.json. */',
        ].join('\n'),
      },
      {
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
