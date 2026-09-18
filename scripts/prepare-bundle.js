import { existsSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync, unlinkSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import semver from 'semver'
import { ALL_BUILTIN_PLUGINS } from '../src/main/own-plugins.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const runtimeDir = join(rootDir, 'bundle-runtime')
const localPluginsDir = join(rootDir, '../plugins')
// 仓内第一方插件：源码就在本仓库里（builtin-plugins/<name>），不依赖外部 repo。
// 与 ../plugins（开发者本机、仓库之外）的区别是：**它会被提交**，所以 CI 也能打包，
// 本地与 CI 走同一条路径。
const inRepoPluginsDir = join(rootDir, 'builtin-plugins')
const cacheDir = process.env.CI ? join(rootDir, '.plugin-cache') : join(tmpdir(), 'jds-plugin-cache')

/** 列出仓内第一方插件目录名（只认带 package.json 的目录）。 */
function listInRepoPlugins() {
  if (!existsSync(inRepoPluginsDir)) return []
  return readdirSync(inRepoPluginsDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(join(inRepoPluginsDir, item.name, 'package.json')))
    .map((item) => item.name)
    .sort()
}

// ---- 参数：--source auto|local|public（默认 auto：本地有就用本地，否则按清单 clone）
const sourceFlag = (() => {
  const i = process.argv.indexOf('--source')
  const v = i !== -1 ? process.argv[i + 1] : undefined
  if (v && !['auto', 'local', 'public'].includes(v)) {
    console.error(`❌ 未知 --source: ${v}（可选 auto|local|public）`)
    process.exit(2)
  }
  return v || 'auto'
})()

// ---- 解析 plugins.manifest.yaml（固定简单 schema，零依赖）
function parseManifest(file) {
  const text = readFileSync(file, 'utf8')
  const plugins = []
  let current = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const itemMatch = line.match(/^\s*-\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/)
    const kvMatch = line.match(/^\s*(name|repo|ref|npm):\s*['"]?([^'"\s]+)['"]?\s*$/)
    if (itemMatch) {
      current = { name: itemMatch[1] }
      plugins.push(current)
    } else if (kvMatch && current) {
      if (kvMatch[1] === 'repo') current.repo = kvMatch[2]
      if (kvMatch[1] === 'ref') current.ref = kvMatch[2]
      if (kvMatch[1] === 'npm') current.npm = kvMatch[2]
      if (kvMatch[1] === 'name' && !itemMatch) current.name = kvMatch[2]
    }
  }
  for (const p of plugins) {
    if (!p.name || (!p.repo && !p.npm)) throw new Error(`manifest 条目不完整: ${JSON.stringify(p)}`)
    p.ref = p.ref || 'main'
  }
  return plugins
}

const manifest = parseManifest(join(rootDir, 'plugins.manifest.yaml'))
const inRepoPlugins = listInRepoPlugins()

// 运行期注册清单与构建清单对账：只警告不阻断（运行期按 existsSync 自愈）
for (const name of ALL_BUILTIN_PLUGINS) {
  const inManifest = manifest.some((p) => p.name === name)
  const inRepo = inRepoPlugins.includes(name)
  if (!inManifest && !inRepo) {
    console.warn(`  ⚠️ 运行期清单(own-plugins.js)里的 ${name} 既不在 plugins.manifest.yaml，也不在 builtin-plugins/`)
  }
}

// 同名同时出现在两处会打出重复插件，明确报错而不是静默取其一
for (const name of inRepoPlugins) {
  if (manifest.some((p) => p.name === name)) {
    console.error(`❌ ${name} 同时出现在 plugins.manifest.yaml 与 builtin-plugins/，请二选一`)
    process.exit(2)
  }
}

console.log(`📦 [1/4] 初始化纯净打包暂存目录... (source=${sourceFlag})`)
if (existsSync(runtimeDir)) {
  try {
    execSync(`rm -rf "${runtimeDir}"`)
  } catch {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
}
mkdirSync(runtimeDir, { recursive: true })
mkdirSync(join(runtimeDir, 'plugins'), { recursive: true })

// ---- 解析每个插件的源码目录：local 优先（auto 时），否则 clone public 固定 ref 或 npm pack 解包
function resolvePluginSource(entry) {
  if (entry.npm) {
    const cache = join(cacheDir, entry.name.replace(/[@/]/g, '_'))
    if (existsSync(cache)) {
      try {
        rmSync(cache, { recursive: true, force: true })
      } catch {
        try { execSync(process.platform === 'win32' ? `rmdir /s /q "${cache}"` : `rm -rf "${cache}"`) } catch {}
      }
    }
    mkdirSync(cache, { recursive: true })
    console.log(`  ⬇️  npm pack ${entry.npm}`)
    execSync(`npm pack ${entry.npm}`, { cwd: cache, stdio: ['ignore', 'pipe', 'pipe'] })
    const tgz = readdirSync(cache).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error(`npm pack 未能生成 tgz 归档: ${entry.npm}`)
    execSync(`tar -xzf "${tgz}" --strip-components=1`, { cwd: cache, stdio: ['ignore', 'pipe', 'pipe'] })
    // 必须删掉解包用的 tgz：它就在 cache 目录里，会被下面的 cpSync 一起复制进
    // bundle-runtime/plugins/<name>/，等于把插件内容在发行版里重复存一份。
    unlinkSync(join(cache, tgz))
    return { dir: cache, origin: `npm@${entry.npm}` }
  }

  const local = join(localPluginsDir, entry.name)
  if (sourceFlag !== 'public' && existsSync(join(local, 'package.json'))) {
    return { dir: local, origin: 'local' }
  }
  if (sourceFlag === 'local') {
    throw new Error(`--source local 但本地缺少插件源码: ${local}`)
  }
  const cache = join(cacheDir, entry.name.replace(/[@/]/g, '_'))
  if (existsSync(cache)) {
    try {
      rmSync(cache, { recursive: true, force: true })
    } catch {
      try {
        execSync(process.platform === 'win32' ? `rmdir /s /q "${cache}"` : `rm -rf "${cache}"`)
      } catch {}
    }
  }
  mkdirSync(cacheDir, { recursive: true })
  console.log(`  ⬇️  clone ${entry.repo} @ ${entry.ref}`)
  cloneAtRef(entry.repo, entry.ref, cache)
  return { dir: cache, origin: `public@${entry.ref}` }
}

/** 判定一个 ref 是不是裸 commit SHA（7~40 位十六进制）。 */
const isCommitSha = (ref) => /^[0-9a-f]{7,40}$/i.test(ref)

/**
 * 把仓库取到指定 ref。
 *
 * 为什么不能直接 `git clone --branch <ref>`：该参数**只接受分支名或标签名**，
 * 传裸 commit SHA 会 fatal 退出。而 plugins.manifest.yaml 用 SHA 钉死构建输入
 * （上游没有可用 tag 时这是唯一办法），所以 SHA 必须走另一条路径。
 *
 * SHA 路径用 `git init` + `git fetch --depth 1 origin <sha>` + `checkout FETCH_HEAD`：
 * GitHub 支持按 SHA fetch，因此仍能保持浅克隆。若服务端拒绝按 SHA fetch，
 * 回落到「全量 clone 后 checkout」。
 */
function cloneAtRef(repo, ref, dest) {
  const opts = { stdio: ['ignore', 'pipe', 'pipe'] }
  if (!isCommitSha(ref)) {
    execSync(`git clone --depth 1 --branch ${ref} "${repo}" "${dest}"`, opts)
    return
  }
  mkdirSync(dest, { recursive: true })
  const inDest = { ...opts, cwd: dest }
  execSync('git init -q', inDest)
  execSync(`git remote add origin "${repo}"`, inDest)
  try {
    execSync(`git fetch --depth 1 origin ${ref}`, inDest)
  } catch {
    console.warn(`  ⚠️  服务端不支持按 SHA 浅取，回落全量 clone: ${repo} @ ${ref}`)
    execSync(`git fetch origin`, inDest)
  }
  execSync('git checkout -q FETCH_HEAD', inDest)
}

/** 判断某个命令是否在 PATH 上（用于 pnpm / npm 二选一）。 */
function hasCommand(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * repo 源插件可能只提交源码：构建产物（如 lib/）被 .gitignore 忽略，靠 prepack 脚本
 * 在 npm 发布时生成，而 git clone **不会**执行 prepack。若不就地构建，后面那道
 * 「入口文件必须存在」的门禁就会直接抛错（这正是它存在的意义：杜绝空壳包）。
 *
 * 策略是「缺什么补什么」，三种情况各自明确：
 *   1. 全部入口产物（main + exports 里的相对文件）已存在 → 直接返回。已提交产物的
 *      插件（如 dsh-today 根目录的 index.js、client.js）命中这条，零额外开销；
 *   2. 产物缺失但声明了 build / prepack / prepare 脚本 → 装依赖并按序补跑
 *      （每跑完一个复查产物，全齐即停；如 dsh-codearts-auth 需要 prepare 补出
 *      lib/client/jet-hub.js，光跑 build 不够）；
 *   3. 产物缺失且没有任何构建脚本 → 不在此处兜底，交给入口门禁抛出可定位的报错。
 *
 * 包管理器优先 pnpm：有 pnpm-lock.yaml / pnpm-workspace.yaml 说明上游用 pnpm，
 * 尊重其锁文件才能得到可复现的产物。CI 由 release.yml 的 pnpm/action-setup 保证可用。
 *
 * --ignore-scripts：只装依赖，不触发依赖的 postinstall；真正的构建在下一步显式执行。
 * --config.confirmModulesPurge=false（仅 pnpm）：避免非交互环境因复用 node_modules
 *   卡在确认提示上。
 */
/**
 * 收集「入口产物目标」：pkg.main + pkg.exports 里所有 ./相对文件路径（排除 *.json）。
 * 只看 main 会漏掉形如 exports["./client"] 的客户端 bundle —— dsh-codearts-auth 就是
 * 这种：tsc 的 build 只产出 lib/index.js，客户端包 lib/client/jet-hub.js 要靠
 * prepare（= build:all = tsc + esbuild）补上，漏了它 Jet Hub 设置页直接加载失败。
 */
function missingEntryFiles(pkg, dir) {
  const targets = []
  // 只把「运行期真实入口的 JS 模块」当作必须存在的产物：
  //  - 跳过含 * 的 glob（如 "./src/*"，exports 里常见，不是真实文件）
  //  - 跳过 .d.ts 类型声明 / .json / .map 等非运行期入口
  // 否则 dsh-reminder 这类 exports 含 "./src/*" 与 "./lib/client.d.ts" 的插件
  // 会被误判为「构建后仍缺入口产物」而报错。
  const pushRel = (v) => {
    if (typeof v !== 'string') return
    if (!v.startsWith('./')) return
    if (v.includes('*')) return
    if (!/\.(js|cjs|mjs)$/.test(v)) return
    targets.push(v)
  }
  if (typeof pkg.main === 'string') targets.push(pkg.main)
  const walk = (v) => {
    if (typeof v === 'string') pushRel(v)
    else if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child)
  }
  if (pkg.exports && typeof pkg.exports === 'object') walk(pkg.exports)
  return [...new Set(targets)].filter((t) => !existsSync(join(dir, t)))
}

function ensureRepoBuilt(dir, entry, origin) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return
  }
  let missing = missingEntryFiles(pkg, dir)
  if (missing.length === 0) return

  // 依次补跑 build → prepack → prepare，每跑完一个就复查产物；
  // 全齐了立即停，保持对旧插件（只需一个 build 就够）的行为与原先一致。
  const scripts = pkg.scripts || {}
  const order = ['build', 'prepack', 'prepare'].filter((s) => typeof scripts[s] === 'string')
  if (order.length === 0) return // 交给后面的入口门禁给出可定位的报错

  const usePnpm =
    (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) &&
    hasCommand('pnpm')
  const pm = usePnpm ? 'pnpm' : 'npm'
  const installArgs = usePnpm
    ? 'install --ignore-scripts --config.confirmModulesPurge=false'
    : 'install --ignore-scripts --no-audit --no-fund'

  // ⚠️ 插件作者本机的 .npmrc 可能把 script-shell 钉死成本机 shell（实测
  // dsh-codearts-auth 提交了 script-shell=C:\Windows\System32\cmd.exe）。后果：
  //   - macOS/Linux runner：spawn cmd.exe → ENOENT → pnpm run 全部 exit -2；
  //   - Windows runner：pnpm 拉起 cmd.exe 却不带 /c 参数 → 变成交互式 shell，
  //     stdin 碰到 EOF 立即退出码 0 —— build「成功」但什么都没构建（更隐蔽）。
  // 这是开发机便利配置，不属于插件运行期依赖，构建前剥掉，pnpm 回落到
  // 各平台默认 shell（Windows 自动带 /c，POSIX 用 /bin/sh）。
  try {
    const rcPath = join(dir, '.npmrc')
    if (existsSync(rcPath)) {
      const cleaned = readFileSync(rcPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !/^\s*script-shell\s*=/.test(line))
        .join('\n')
      if (cleaned !== readFileSync(rcPath, 'utf8')) writeFileSync(rcPath, cleaned)
    }
  } catch {}
  const opts = { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }

  try {
    execSync(`${pm} ${installArgs}`, opts)
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').slice(-12).join('\n')
    throw new Error(`插件 ${entry.name} 安装依赖失败（${pm} install）:\n${out}`)
  }

  for (const script of order) {
    missing = missingEntryFiles(pkg, dir)
    if (missing.length === 0) break
    console.log(`  🔨 构建插件（${origin} 只含源码，缺 ${missing.join(', ')}）: ${entry.name} → ${pm} run ${script}`)
    try {
      execSync(`${pm} run ${script}`, opts)
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').slice(-12).join('\n')
      throw new Error(`插件 ${entry.name} 就地构建失败（${pm} run ${script}）:\n${out}`)
    }
  }
  missing = missingEntryFiles(pkg, dir)
  if (missing.length > 0) {
    throw new Error(`插件 ${entry.name} 构建后仍缺少入口产物 ${missing.join(', ')}，请检查上游的构建脚本（build/prepack/prepare）。`)
  }
}

console.log('🧩 [2/4] 收纳精选插件与依赖...')
/**
 * 插件运行期兼容补丁（表驱动）。
 *
 * 目标插件是第三方仓库（CI 现场 clone），它们的实现细节与本发行版的宿主策略
 * 有冲突时只能在这里构建期改写。逐条替换、幂等：已打过就跳过，锚点没命中只告警
 * 不中断（上游改结构时仍能出包，只是需要人工同步补丁）。
 */
const PLUGIN_RUNTIME_PATCHES = [
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
]

/**
 * 应用插件运行期兼容补丁。
 * @param {string} name 插件名
 * @param {string} dir 已暂存的插件目录（bundle-runtime/plugins/<name>）
 */
function applyPluginRuntimePatches(name, dir) {
  const entry = PLUGIN_RUNTIME_PATCHES.find((it) => it.plugin === name)
  if (entry === undefined) return
  let applied = 0
  for (const edit of entry.edits) {
    const file = join(dir, edit.file)
    if (!existsSync(file)) {
      console.warn(`  ⚠️ 插件补丁目标文件不存在: ${name}/${edit.file}`)
      continue
    }
    const text = readFileSync(file, 'utf8')
    // 支持 fromLines/toLines：按文件自身行尾拼接（上游文件可能是 CRLF，LF 锚点会全部失配）
    const EOL = text.includes('\r\n') ? '\r\n' : '\n'
    const from = edit.fromLines ? edit.fromLines.join(EOL) : edit.from
    const to = edit.toLines ? edit.toLines.join(EOL) : edit.to
    if (from === undefined || to === undefined) {
      console.warn(`  ⚠️ 插件补丁缺少 from/to: ${name}/${edit.file}`)
      continue
    }
    if (text.includes(to)) continue // 幂等
    if (!text.includes(from)) {
      console.warn(
        `  ⚠️ 插件补丁未命中（上游结构可能已变）: ${name}/${edit.file} ← ${JSON.stringify(from.slice(0, 48))}`,
      )
      continue
    }
    writeFileSync(file, text.replaceAll(from, to))
    applied += 1
  }
  if (applied > 0) {
    console.log(`  🔧 插件兼容补丁（${applied} 处）: ${name}（${entry.desc ?? '兼容修复'}）`)
  }
}


/**
 * 插件侧品牌对齐补丁：把上游插件硬编码的旧品牌目录字面量换成本发行版的 LJANX，
 * 并保留对旧目录（JackDSH）的只读回退，老用户的既有数据不会「找不到」。
 *
 * 目标目前只有 dsh-today/resolve.js（`~/Documents/JackDSH` 品牌标准根目录解析）。
 * 逐条替换，任何一条没匹配到只打印告警、不中断构建——上游改结构时插件仍可打包，
 * 只是需要人工同步本补丁。
 *
 * @param {string} name 插件名
 * @param {string} dir 已暂存的插件目录（bundle-runtime/plugins/<name>）
 */
function applyPluginBrandAlignment(name, dir) {
  if (name !== 'dsh-today') return
  const file = join(dir, 'resolve.js')
  if (!existsSync(file)) return
  let text = readFileSync(file, 'utf8')
  // ⚠️ 上游文件是 CRLF：多行锚点必须按文件自身行尾拼，否则一处都匹配不上
  const EOL = text.includes('\r\n') ? '\r\n' : '\n'
  const L = (...lines) => lines.join(EOL)
  const edits = [
    // 便携模式：<根目录>/JackDSH → <根目录>/LJANX
    {
      from: "join(portableRoot, 'JackDSH')",
      to: "join(portableRoot, 'LJANX')",
    },
    // Documents 下：LJANX 优先，回退旧目录 JackDSH（老用户的既有当日工作区）
    {
      from: L(
        "    const jackDoc = join(docDir, 'JackDSH')",
        '    if (existsSync(jackDoc) && isDirectory(jackDoc)) return jackDoc',
      ),
      to: L(
        "    const ljanxDoc = join(docDir, 'LJANX')",
        '    if (existsSync(ljanxDoc) && isDirectory(ljanxDoc)) return ljanxDoc',
        "    const jackDoc = join(docDir, 'JackDSH')",
        '    if (existsSync(jackDoc) && isDirectory(jackDoc)) return jackDoc',
      ),
    },
    // 新建机器时默认返回 Documents/LJANX
    { from: L('    return jackDoc', '  }'), to: L('    return ljanxDoc', '  }') },
    // 家目录兜底：LJANX 优先，回退旧 JackDSH
    {
      from: L("  const jackHome = join(home, 'JackDSH')", '  if (existsSync(jackHome) && isDirectory(jackHome)) return jackHome'),
      to: L(
        "  const ljanxHome = join(home, 'LJANX')",
        '  if (existsSync(ljanxHome) && isDirectory(ljanxHome)) return ljanxHome',
        "  const jackHome = join(home, 'JackDSH')",
        '  if (existsSync(jackHome) && isDirectory(jackHome)) return jackHome',
      ),
    },
    { from: L('  return jackHome', '}'), to: L('  return ljanxHome', '}') },
  ]
  let applied = 0
  for (const edit of edits) {
    if (text.includes(edit.to)) continue // 已打过（幂等）
    if (!text.includes(edit.from)) {
      console.warn(
        `  ⚠️ 品牌对齐补丁未命中（上游结构可能已变）: ${name}/resolve.js ← ${JSON.stringify(edit.from.slice(0, 44))}`,
      )
      continue
    }
    text = text.replaceAll(edit.from, edit.to)
    applied += 1
  }
  if (applied > 0) {
    writeFileSync(file, text)
    console.log(`  🏷️ 品牌对齐补丁（${applied} 处）: ${name}/resolve.js → LJANX（保留 JackDSH 只读回退）`)
  }
}


const pluginSources = [
  ...manifest.map((entry) => ({ entry, inRepo: false })),
  ...inRepoPlugins.map((name) => ({ entry: { name }, inRepo: true })),
]
for (const { entry, inRepo } of pluginSources) {
  const { dir: src, origin } = inRepo
    ? { dir: join(inRepoPluginsDir, entry.name), origin: 'in-repo' }
    : resolvePluginSource(entry)
  if (origin.startsWith('public@')) ensureRepoBuilt(src, entry, origin)
  const dest = join(runtimeDir, 'plugins', entry.name)
  mkdirSync(dirname(dest), { recursive: true })
  console.log(`  -> 复制插件: ${entry.name} (${origin})`)
  cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => {
      // 过滤规则：严禁打包 .git, .env, credentials, 缓存, 会话
      const base = srcPath.split(/[/\\]/).pop() || ''
      if (base === '.git' || base === '.DS_Store' || base === 'node_modules') return false
      if (base.startsWith('.env') || base.includes('credential') || base.includes('token.json')) return false
      if (base === '.dsh-mobile-inbox') return false
      return true
    },
  })

  // ── 品牌对齐补丁（插件侧）──────────────────────────────────────────────
  // 宿主自 v1.2.0 起品牌标识统一为 LJANX（当日工作区根目录 ~/Documents/LJANX），
  // 但上游插件把旧品牌目录字面量硬编码在源码里（如 dsh-today 的
  // resolve.js 把 ~/Documents/JackDSH 当「品牌标准根目录」）。不处理的话，
  // 宿主与插件会各写一个目录。这里做窄范围替换：新名优先，旧目录保留只读回退，
  // 老用户既有的当日工作区仍能被找到。
  applyPluginBrandAlignment(entry.name, dest)

  // 插件运行期兼容补丁（表驱动，见 PLUGIN_RUNTIME_PATCHES 的成因说明）
  applyPluginRuntimePatches(entry.name, dest)

  // 关键门禁校验：严查插件入口文件（main / exports）是否真实存在，杜绝缺少 lib/ 编译产物打出空壳包
  const pluginPkgPath = join(dest, 'package.json')
  if (existsSync(pluginPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pluginPkgPath, 'utf8'))
      if (pkg.main) {
        const entryFile = join(dest, pkg.main)
        if (!existsSync(entryFile)) {
          throw new Error(`插件 ${entry.name} 的入口文件 ${pkg.main} 不存在！请先构建该插件或将 lib/ 构建产物提交到 Git。`)
        }
      }
    } catch (e) {
      if (e.message.includes('入口文件')) throw e
    }
  }
}

// ---- [3/4] 准备内置 CLI 工具 (BrowserSkill bsk)
console.log('🧩 [2.5/4] 内核兼容性门禁...')
// 内核随包发布后没有运行期更新轨道，「不兼容插件自动停用」从旧 core-updater
// 挪到构建时：compatibility.json 显式声明的 verifiedVersions 覆盖不到本次内核
// 版本的插件，改名成 .disabled-<名> 让运行期失效（initIsolatedProfile 的自愈
// 逻辑会把它们从 profile.bundles 清掉；插件作者声明支持新内核后自动恢复）。
// 只信显式声明、核心三位版本号相同即兼容——判定口径与旧 core-updater 一致，
// ⚠️ 不要拿 peerDependencies 范围去推断（预发布 semver 语义会误判）。
function pluginSupportsCore(dir, targetVersion) {
  const compatPath = join(dir, 'compatibility.json')
  if (!existsSync(compatPath)) return { declared: false }
  let list = []
  try {
    const c = JSON.parse(readFileSync(compatPath, 'utf8'))
    list = (c && c.dsh && Array.isArray(c.dsh.verifiedVersions)) ? c.dsh.verifiedVersions : []
  } catch {
    return { declared: false }
  }
  if (list.length === 0) return { declared: false }
  const ok = list.some((v) => {
    if (v === targetVersion) return true
    try {
      if (semver.validRange(v) && semver.satisfies(targetVersion, v)) return true
      const a = semver.parse(v)
      const b = semver.parse(targetVersion)
      return a && b && a.major === b.major && a.minor === b.minor && a.patch === b.patch
    } catch { return false }
  })
  return { declared: true, ok, reason: `仅验证到 ${list.join(' / ')}` }
}

const coreVersionForGating = (() => {
  try {
    return JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'] || ''
  } catch { return '' }
})()

if (coreVersionForGating) {
  const pluginsRoot = join(runtimeDir, 'plugins')
  let disabledCount = 0
  for (const entry of readdirSync(pluginsRoot)) {
    if (entry.startsWith('.disabled-')) continue
    const children = entry.startsWith('@')
      ? readdirSync(join(pluginsRoot, entry)).map((leaf) => ({ parent: entry, leaf }))
      : [{ parent: '', leaf: entry }]
    for (const { parent, leaf } of children) {
      const dir = join(pluginsRoot, parent, leaf)
      if (!existsSync(join(dir, 'package.json'))) continue
      const verdict = pluginSupportsCore(dir, coreVersionForGating)
      if (verdict.declared && !verdict.ok) {
        const display = parent ? `${parent}/${leaf}` : leaf
        try {
          renameSync(dir, join(pluginsRoot, parent, `.disabled-${leaf}`))
          disabledCount += 1
          console.log(`  🚫 停用不兼容插件: ${display}（${verdict.reason}；内核 ${coreVersionForGating}）`)
        } catch (error) {
          console.warn(`  ⚠️ 停用失败（保留启用态）: ${display}: ${error.message}`)
        }
      }
    }
  }
  console.log(`  门禁完成：内核 ${coreVersionForGating}，停用 ${disabledCount} 个显式声明不兼容的插件`)
} else {
  console.log('  ⏭️ 读不到内核版本声明，跳过门禁（交由运行期自愈逻辑兜底）')
}

console.log('🩹 [2.6/4] 内核兼容补丁...')
// 内核随包发布后，旧 core-updater 里「升级时给暂存内核打上游回归补丁」的
// 逻辑必须搬到这里——否则升上去的裸内核会踩已知上游回归：
// 0.1.5-rc.1 起 dsh-client-connection 删了 webServer inject 却仍在 register()
// 里使用，任何调用 ctx.connection.rpc.handle() 的插件都会让内核启动即崩
// （loadProfileDirectory 处 cannot get property "webServer" without inject）。
// ⚠️ 补丁打在**仓库 node_modules** 上（CI 里 pnpm install 后、electron-builder
// 打包 extraResources 前；本地 dev 也在每次 prepare-bundle 时补齐）。
// 找不到目标代码时不报错——上游将来修好或改了写法，都不该被这里卡住。
const CORE_COMPAT_PATCHES = [
  {
    id: 'connection-inject-webServer',
    file: 'dsh-client-connection/lib/index.js',
    appliesTo: (version) => {
      try { return semver.gte(version, '0.1.5-rc.1') } catch { return false }
    },
    find: 'inject = ["credentials"]',
    replace: 'inject = ["webServer", "credentials"]',
  },
  {
    id: 'session-migrator-llm-signatures',
    file: 'dsh-session-format-v0-to-v1/lib/index.js',
    appliesTo: (version) => {
      try { return semver.gte(version, '0.1.5-rc.1') } catch { return false }
    },
    find: 'assertReleasedV0Keys(block, ["type", "text"], [], label);',
    replace: 'assertReleasedV0Keys(block, ["type", "text"], ["textSignature", "thinkingSignature", "thoughtSignature"], label);',
  },
  {
    id: 'session-migrator-signature-members',
    file: 'dsh-session-format-v0-to-v1/lib/index.js',
    appliesTo: (version) => {
      try { return semver.gte(version, '0.1.5-rc.1') } catch { return false }
    },
    // 通用兜底：LLM 提供方的签名成员（textSignature/thinkingSignature/thoughtSignature…）
    // 会出现在 text/reasoning/tool-call 等各类内容块上，逐块白名单打地鼠不如
    // 在「意外成员」检查里统一豁免 *Signature——签名是提供方不透明元数据，
    // 放行不影响迁移的结构映射。
    find: 'const unexpected = Object.keys(record).find((key) => !allowed.has(key));',
    replace: 'const unexpected = Object.keys(record).find((key) => !allowed.has(key) && !key.endsWith("Signature"));',
  },
  {
    id: 'pi-ai-model-context-undefined',
    file: 'dsh-llm-pi-ai/lib/index.js',
    appliesTo: (version) => {
      try { return semver.gte(version, '0.1.5-rc.1') } catch { return false }
    },
    // 上游 bug：modelInfo() 无条件返回 context:{contextWindow}，当 Trae 等
    // 适配器的模型未提供上下文窗口时值为 undefined → rc.2 校验拒绝
    // （adapter returned invalid context metadata）→ 该模型无法加载/切换。
    // 修正为 contextWindow 未知时省略整个 context 字段（校验允许缺省）。
    find: 'context: { contextWindow: resolvedModel.contextWindow },',
    replace: '...resolvedModel.contextWindow === void 0 ? {} : { context: { contextWindow: resolvedModel.contextWindow } },',
  },
  {
    id: 'win32-process-create-no-window',
    file: 'dsh-win32-process/lib/index.js',
    appliesTo: (version) => true,
    // Electron 主进程无控制台，创建子进程时缺 CREATE_NO_WINDOW 会导致 Windows
    // 为每个子进程分配控制台，默认终端（Windows Terminal）会弹出可见窗口。
    find: 'createRestrictedProcess(api, options, buildCommandLine(options.command, options.args), 0, startupInfo, processInfo)',
    replace: 'createRestrictedProcess(api, options, buildCommandLine(options.command, options.args), 0x08000000, startupInfo, processInfo)',
  },
  {
    id: 'win32-process-job-suspended-no-window',
    file: 'dsh-win32-process/lib/index.js',
    appliesTo: (version) => true,
    find: 'createRestrictedProcess(api, options, commandLine, 4, startupInfo, processInfo)',
    replace: 'createRestrictedProcess(api, options, commandLine, 4 | 0x08000000, startupInfo, processInfo)',
  },
  {
    id: 'win32-process-createw-no-window',
    file: 'dsh-win32-process/lib/index.js',
    appliesTo: (version) => true,
    find: 'api.createProcessW(options.applicationName, commandLine, null, null, 1, 1028, environment',
    replace: 'api.createProcessW(options.applicationName, commandLine, null, null, 1, 1028 | 0x08000000, environment',
  },
  {
    id: 'subprocess-local-windows-hide',
    file: 'dsh-subprocess-local/lib/index.js',
    appliesTo: (version) => true,
    find: 'stdio: runnerStdio(spec, true, ignoredStdinFd ?? "pipe")',
    replace: 'stdio: runnerStdio(spec, true, ignoredStdinFd ?? "pipe"),\n\t\t\twindowsHide: (internals.platform ?? process.platform) === "win32"',
  },
]

if (coreVersionForGating) {
  for (const patch of CORE_COMPAT_PATCHES) {
    if (!patch.appliesTo(coreVersionForGating)) continue
    // patch.file 相对 @deepseek-ai scope（与旧 core-updater 的暂存目录口径一致）
    const file = join(rootDir, 'node_modules', '@deepseek-ai', patch.file)
    if (!existsSync(file)) {
      console.warn(`  ⚠️ 补丁 ${patch.id}：文件缺失 ${patch.file}，跳过`)
      continue
    }
    const raw = readFileSync(file, 'utf8')
    if (raw.includes(patch.replace)) {
      console.log(`  ✅ 补丁 ${patch.id}：已是修复形态（重复执行/上游已修）`)
      continue
    }
    if (!raw.includes(patch.find)) {
      console.warn(`  ⚠️ 补丁 ${patch.id}：找不到目标代码（上游可能已改写法），交由启动验证裁决`)
      continue
    }
    writeFileSync(file, raw.replace(patch.find, patch.replace))
    console.log(`  🩹 已打补丁 ${patch.id} → ${patch.file}（内核 ${coreVersionForGating}）`)
  }
} else {
  console.log('  ⏭️ 无内核版本声明，跳过兼容补丁')
}

console.log('🛠️ [3/4] 准备内置 CLI 工具 (BrowserSkill bsk)...')

function prepareBskCli(targetDir, manifestList) {
  const binDir = join(targetDir, 'bin')
  mkdirSync(binDir, { recursive: true })

  // 1. 确定需要的 bsk 版本（跟随 browser-skill 插件版本，默认 0.2.1）
  const bskEntry = manifestList.find((p) => p.name === '@wxg-prc-cpg/browser-skill-dsh-plugin')
  let bskVersion = '0.2.1'
  if (bskEntry?.npm) {
    const match = bskEntry.npm.match(/@(\d+\.\d+\.\d+.*)$/)
    if (match) bskVersion = match[1]
  }

  const bskCacheRoot = join(cacheDir, 'bsk-bin')
  mkdirSync(bskCacheRoot, { recursive: true })

  // 2. 预设支持的目标平台架构与官方资产
  const targets = [
    {
      id: 'darwin-arm64',
      fileName: 'bsk',
      asset: `bsk-v${bskVersion}-aarch64-apple-darwin.tar.gz`,
      type: 'tar.gz',
    },
    {
      id: 'win32-x64',
      fileName: 'bsk.exe',
      asset: `bsk-v${bskVersion}-x86_64-pc-windows-msvc.zip`,
      type: 'zip',
    },
  ]

  if (process.arch === 'x64' && process.platform === 'darwin') {
    targets.unshift({
      id: 'darwin-x64',
      fileName: 'bsk',
      asset: `bsk-v${bskVersion}-x86_64-apple-darwin.tar.gz`,
      type: 'tar.gz',
    })
  }

  for (const t of targets) {
    const cachedBinary = join(bskCacheRoot, t.id, t.fileName)
    const targetPlatformDir = join(binDir, t.id)
    mkdirSync(targetPlatformDir, { recursive: true })
    const destInPlatform = join(targetPlatformDir, t.fileName)

    if (!existsSync(cachedBinary)) {
      mkdirSync(dirname(cachedBinary), { recursive: true })

      // 本地极速加速：若本机 ~/.local/bin/bsk 已存在且版本匹配，直接复用
      const currentPlatformId = `${process.platform}-${process.arch}`
      const localMachineBsk = join(homedir(), '.local', 'bin', t.fileName)
      let usedLocal = false
      if (t.id === currentPlatformId && existsSync(localMachineBsk)) {
        try {
          const verOut = execSync(`"${localMachineBsk}" --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
          if (verOut.includes(bskVersion)) {
            cpSync(localMachineBsk, cachedBinary)
            console.log(`  -> 复用本机已安装的 bsk [${t.id}] (${verOut.trim()})`)
            usedLocal = true
          }
        } catch {}
      }

      if (!usedLocal) {
        const downloadUrl = `https://github.com/Tencent/BrowserSkill/releases/download/cli-v${bskVersion}/${t.asset}`
        const tempArchive = join(bskCacheRoot, `${t.id}-${t.asset}`)
        console.log(`  ⬇️  下载 BrowserSkill [${t.id}] -> ${t.asset}`)
        try {
          execSync(`curl -fsSL "${downloadUrl}" -o "${tempArchive}"`, { stdio: ['ignore', 'pipe', 'pipe'] })
          const extractDir = join(bskCacheRoot, `extract-${t.id}`)
          rmSync(extractDir, { recursive: true, force: true })
          mkdirSync(extractDir, { recursive: true })
          if (t.type === 'tar.gz') {
            execSync(`tar -xzf "${tempArchive}" -C "${extractDir}"`, { stdio: ['ignore', 'pipe', 'pipe'] })
          } else if (t.type === 'zip') {
            execSync(`unzip -o -q "${tempArchive}" -d "${extractDir}"`, { stdio: ['ignore', 'pipe', 'pipe'] })
          }
          const found = existsSync(join(extractDir, t.fileName))
            ? join(extractDir, t.fileName)
            : readdirSync(extractDir).map((f) => join(extractDir, f)).find((p) => p.endsWith(t.fileName))
          if (!found) throw new Error(`解压包中未找到 ${t.fileName}`)
          cpSync(found, cachedBinary)
          rmSync(extractDir, { recursive: true, force: true })
          rmSync(tempArchive, { force: true })
        } catch (err) {
          console.warn(`  ⚠️ 下载/解压 ${t.id} 失败: ${err.message}`)
        }
      }
    }

    if (existsSync(cachedBinary)) {
      cpSync(cachedBinary, destInPlatform)
      if (t.fileName !== 'bsk.exe') {
        try { chmodSync(destInPlatform, 0o755) } catch {}
      }
      // 如果与当前宿主平台架构匹配，在 bin/ 根目录也放一份直接可执行文件
      const currentHostId = `${process.platform}-${process.arch}`
      if (t.id === currentHostId) {
        const topLevelDest = join(binDir, t.fileName)
        cpSync(cachedBinary, topLevelDest)
        if (t.fileName !== 'bsk.exe') {
          try { chmodSync(topLevelDest, 0o755) } catch {}
        }
        console.log(`  ✅ 内置当前宿主 bsk 就绪: ${topLevelDest}`)
      } else {
        console.log(`  ✅ 内置跨平台资产就绪: ${destInPlatform}`)
      }
    }
  }
}

prepareBskCli(runtimeDir, manifest)

console.log('🚀 [4/4] 生成独立运行入口 entry.js...')
const entryContent = `/**
 * DeepSeek Agent Embedded Core Entry
 * Boots the official DeepSeek Harness Web engine
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const portIndex = process.argv.indexOf('--port')
const port = portIndex !== -1 ? process.argv[portIndex + 1] : (process.env.DSH_PORT || '3180')

console.log(\`[DeepSeek Agent] Booting DeepSeek Harness Web core on port \${port}...\`)

process.argv = [process.execPath, 'dsh', 'web', '--port', String(port), '--no-open']
await import('@deepseek-ai/dsh/lib/bin.js')
`

writeFileSync(join(runtimeDir, 'entry.js'), entryContent)
console.log('✅ 打包暂存区构建完成！')
