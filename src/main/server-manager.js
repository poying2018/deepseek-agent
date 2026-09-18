import { fork, spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, lstatSync, readlinkSync, unlinkSync, symlinkSync, cpSync, createWriteStream, chmodSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { OWN_PLUGINS, ALL_BUILTIN_PLUGINS } from './own-plugins.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 内置「浏览交互」两面（host 能力行 + 客户端界面行）的包名。
 * seam 文档把「固定某种交互」定义为：停用自适应选择器行，再直接组合这一对行。
 * 两面必须成对出现，理由见 ServerManager#pickerPatchLines。
 */
const PICKER_BROWSE_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const PICKER_BROWSE_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'

/** LJANX 托管补丁区的起止标记：每次启动按平台/环境重写，能把历史上写坏的内容自动纠正。 */
const MANAGED_BEGIN = '# >>> LJANX 托管区：启动时自动重写，请勿手工编辑 >>>'
const MANAGED_END = '# <<< LJANX 托管区 <<<'
// 品牌改名（JackDSH → LJANX）后标记随之变化。存量 profile 的 cordis.patch.yml
// 里还是旧标记，若不先升级标记，spliceManagedRegion 找不到新区 → 会**追加**
// 第二个托管区，新旧补丁并存（同一 id 被禁两次/插两次）。升级时只换标记行，
// 区内容随后按当前代码整段重写。
const MANAGED_BEGIN_LEGACY = '# >>> JackDSH 托管区：启动时自动重写，请勿手工编辑 >>>'
const MANAGED_END_LEGACY = '# <<< JackDSH 托管区 <<<'

/** 本发行版自己管过的补丁行 id：重写托管区前，先摘掉没有标记的历史版本。 */
const MANAGED_ROW_IDS = ['directory-picker', 'client-hmr', 'dsh-mobile-plus']

export class ServerManager {
  /**
   * @param {Object} options
   * @param {number} options.port
   * @param {boolean} [options.isPortable]
   * @param {string} [options.appDataPath]
   * @param {string} [options.runtimePath]
   */
  constructor(options) {
    this.port = options.port
    this.isPortable = Boolean(options.isPortable)
    this.childProcess = null
    this.runtimePath = options.runtimePath || join(__dirname, '../../bundle-runtime')

    // 确定隔离的数据存放目录（DSH_HOME），支持用户自定义，见 resolveDshHome
    this.dshHome = this.resolveDshHome(options.appDataPath)
    this.defaultWorkspace = join(this.dshHome, 'workspace')
    this.logFile = join(this.dshHome, 'dsh-web.log')
    this.lastExitCode = null
    // 核心启动时打印的带 token 认证地址（见 awaitAuthToken 的成因说明）
    this.authenticatedUrl = ''
  }

  /**
   * 解析数据目录（DSH_HOME），优先级从高到低：
   *  1. portable 模式：当前工作目录下 data/.dsh（既有行为，U 盘即用）；
   *  2. 启动参数 `--dsh-home <path>`；
   *  3. 环境变量 `JDS_DSH_HOME`；
   *  4. 覆盖文件 `<userData>/dsh-home.json`（{"dshHome": "..."}，
   *     预留给以后设置界面的「选择数据目录」写盘）；
   *  5. 默认隔离目录 <userData>/dsh-data。
   * 支持 ~ / ~/ 前缀展开。注意：切换目录不会自动迁移旧数据，
   * 新目录按全新隔离环境初始化（插件会自动重新注册）。
   * @param {string} [appDataPath] Electron userData 目录
   * @returns {string} 绝对路径
   */
  resolveDshHome(appDataPath) {
    if (this.isPortable) return join(process.cwd(), 'data', '.dsh')

    const expand = (p) => {
      if (p === '~') return homedir()
      if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
      return p
    }

    const argIndex = process.argv.indexOf('--dsh-home')
    const fromArg = argIndex !== -1 ? process.argv[argIndex + 1] : undefined
    const fromEnv = process.env.JDS_DSH_HOME
    let fromFile
    if (appDataPath) {
      try {
        const raw = readFileSync(join(appDataPath, 'dsh-home.json'), 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.dshHome === 'string' && parsed.dshHome.trim()) {
          fromFile = parsed.dshHome.trim()
        }
      } catch {
        fromFile = undefined
      }
    }

    const chosen = [fromArg, fromEnv, fromFile].find((v) => typeof v === 'string' && v.trim().length > 0)
    if (chosen) return resolve(expand(chosen.trim()))

    if (appDataPath) return join(appDataPath, 'dsh-data')
    const baseDir = process.platform === 'win32'
      ? (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
      : (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : join(homedir(), '.config'))
    return join(baseDir, 'DeepSeek-Harness-Desktop', 'data')
  }

  /**
   * 自动解析并创建当日工作区：
   * 便携模式：<dshHome>/LJANX/days/YYYY-MM-DD
   * 常规模式：~/Documents/LJANX/days/YYYY-MM-DD（若无 Documents 则兜底 ~/LJANX）
   * 使得无论是网吧便携还是个人 Mac，冷启动打开直接进入当天的专属工作区。
   */
  resolveInitialWorkspace() {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const today = `${y}-${m}-${d}`

    if (this.isPortable) {
      const portableDays = join(this.dshHome, 'LJANX', 'days', today)
      try {
        mkdirSync(portableDays, { recursive: true })
        return portableDays
      } catch (err) {
        console.warn(`[ServerManager] failed to create portable workspace: ${err.message}`)
      }
    }

    const docDir = join(homedir(), 'Documents')
    if (existsSync(docDir)) {
      const todayDir = join(docDir, 'LJANX', 'days', today)
      try {
        mkdirSync(todayDir, { recursive: true })
        return todayDir
      } catch (err) {
        console.warn(`[ServerManager] failed to create documents workspace: ${err.message}`)
      }
    }

    const fallbackDir = join(homedir(), 'LJANX', 'days', today)
    try {
      mkdirSync(fallbackDir, { recursive: true })
      return fallbackDir
    } catch {
      return join(this.dshHome, 'workspace')
    }
  }

  /**
   * Ensure clean isolated directory structure & default settings
   */
  initIsolatedStorage() {
    mkdirSync(this.dshHome, { recursive: true })
    this.defaultWorkspace = this.resolveInitialWorkspace()
    mkdirSync(this.defaultWorkspace, { recursive: true })

    const settingsFile = join(this.dshHome, 'settings.yaml')
    if (!existsSync(settingsFile)) {
      const templatePath = join(__dirname, '../../config-templates/default-settings.yaml')
      if (existsSync(templatePath)) {
        copyFileSync(templatePath, settingsFile)
      }
    }
    this.migrateSettingsDefaults(settingsFile)

    // 确保出厂内置的「LJANX 模式」预设存在于隔离环境
    const presetDir = join(this.dshHome, '.agent-presets', 'ljanx')
    mkdirSync(presetDir, { recursive: true })
    // 品牌改名迁移：旧版把出厂预设放在 .agent-presets/jack（id 也是 jack），
    // 若新目录还没有内容、旧目录存在，就把用户那份（可能已被他改过）搬过来，
    // 保住自定义内容不被出厂模板覆盖。
    const legacyPresetDir = join(this.dshHome, '.agent-presets', 'jack')
    if (existsSync(legacyPresetDir) && !existsSync(join(presetDir, 'agent.cordis.yml'))) {
      for (const file of ['preset.yml', 'agent.cordis.yml']) {
        const from = join(legacyPresetDir, file)
        const to = join(presetDir, file)
        if (existsSync(from) && !existsSync(to)) {
          try {
            copyFileSync(from, to)
          } catch (err) {
            console.warn(`[ServerManager] failed to migrate preset file ${file}: ${err.message}`)
          }
        }
      }
      console.log('[ServerManager] 已从 .agent-presets/jack 迁移预设到 .agent-presets/ljanx')
    }
    const templatePresetDir = join(__dirname, '../../config-templates/presets/ljanx')
    if (existsSync(templatePresetDir)) {
      for (const file of ['preset.yml', 'agent.cordis.yml']) {
        const dest = join(presetDir, file)
        const src = join(templatePresetDir, file)
        if (!existsSync(dest) && existsSync(src)) {
          try {
            copyFileSync(src, dest)
          } catch (err) {
            console.warn(`[ServerManager] failed to copy preset file ${file}: ${err.message}`)
          }
        }
      }
    }

    // 权限自愈防护：确保敏感凭据符合官方 @deepseek-ai/dsh-credentials-local (mode 600) 安全标准
    if (process.platform !== 'win32') {
      const sensitiveFiles = [
        '.credentials.yaml',
        'grok-oauth.json',
        'gemini-oauth.json',
        'gemini-oauth-models.json',
      ]
      for (const file of sensitiveFiles) {
        const fullPath = join(this.dshHome, file)
        if (existsSync(fullPath)) {
          try {
            chmodSync(fullPath, 0o600)
          } catch {}
        }
      }
    }
  }

  /**
   * 存量隔离环境迁移：旧模板生成的 settings.yaml 缺少内置插件需要的
   * 配置命名空间（如 llm-grok）或默认预设设置。只补不删，绝不动用户已写的内容。
   */
  migrateSettingsDefaults(settingsFile) {
    try {
      let raw = readFileSync(settingsFile, 'utf8')
      let changed = false

      if (!raw.includes('agent-presets:')) {
        raw += '\n# 默认启用高效自主编码 Agent 预设\nagent-presets:\n  default: ljanx\n'
        changed = true
      } else if (/^\s*default:\s*jack\s*$/m.test(raw)) {
        // 品牌改名：旧版把出厂预设 id 写成 `jack`，预设目录已迁到 ljanx，
        // 这里把默认预设指向新 id，否则内核会找不到预设而回退到无预设模式。
        raw = raw.replace(/^(\s*default:\s*)jack\s*$/m, '$1ljanx')
        changed = true
      }

      if (!raw.includes('llm-grok:')) {
        const block = [
          '',
          '# LJANX 内置插件默认配置（首次升级自动补充）',
          'llm-grok:',
          '  enableImageGen: true',
          '  models:',
          '    - id: grok-4.6',
          '      name: Grok 4.6',
          '      thinking: true',
          '      vision: true',
          '      contextWindow: 500000',
          '',
        ].join('\n')
        raw = raw.endsWith('\n') ? raw + block : raw + '\n' + block
        changed = true
      }

      if (changed) {
        writeFileSync(settingsFile, raw)
      }
    } catch (error) {
      console.warn(`[ServerManager] settings migration skipped: ${error.message}`)
    }
  }

  /**
   * 把 App 内置的自研插件注册进隔离 profile（幂等，可自愈）。
   *
   * DSH 的插件机制 = profiles/web/package.json 的 dsh.profile.bundles 清单
   * + 从 profile 目录可 Node 解析到的包。这里：
   *  1. 合并 bundles 清单（保留核心默认 bundle 与用户后装的插件，只补不删）；
   *  2. 为每个内置插件在 profiles/web/node_modules 下建解析链接，
   *     指向 App 包内 runtime/plugins/<name>（真实路径向上遍历可命中
   *     App 内置 hoisted node_modules，undici / pi-ai / cordis / react 等
   *     依赖均可解析，无需目标机器安装 pnpm）。
   * 链接创建失败（如 Windows 无权限）时退化为物理复制。
   */
  initIsolatedProfile() {
    const profileDir = join(this.dshHome, 'profiles', 'web')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

    const pluginsRoot = join(this.runtimePath, 'plugins')
    const available = ALL_BUILTIN_PLUGINS.filter((name) => existsSync(join(pluginsRoot, name, 'package.json')))

    const manifestPath = join(profileDir, 'package.json')
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      manifest = null
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      manifest = { name: 'dsh-profile-web', private: true, dependencies: {} }
    }
    manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
    manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
    const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : []

    // 自动自愈：清理已废弃或断开的旧内置插件软链与 bundles 声明，防止 DSH 内核因找不到 bundle 崩溃黑屏
    const profileNodeModules = join(profileDir, 'node_modules')
    const userDeps = manifest.dependencies && typeof manifest.dependencies === 'object' ? Object.keys(manifest.dependencies) : []
    const cleanedBundles = []

    for (const b of bundles) {
      if (b === '@deepseek-ai/dsh-base' || b === '@deepseek-ai/dsh-web-app' || b.startsWith('@deepseek-ai/')) {
        cleanedBundles.push(b)
        continue
      }
      if (userDeps.includes(b)) {
        cleanedBundles.push(b)
        continue
      }
      if (available.includes(b)) {
        cleanedBundles.push(b)
      } else {
        // 不在当前内置列表，检查 node_modules 中是否真的存在可用包；若为坏软链或不存在则自动剔除
        const pkgPath = join(profileNodeModules, b, 'package.json')
        if (existsSync(pkgPath)) {
          cleanedBundles.push(b)
        } else {
          console.log(`[ServerManager] 自动清理失效/已废弃插件 bundle 声明: ${b}`)
          const deadLink = join(profileNodeModules, b)
          try { unlinkSync(deadLink) } catch {}
        }
      }
    }

    if (!cleanedBundles.includes('@deepseek-ai/dsh-base')) cleanedBundles.unshift('@deepseek-ai/dsh-base')
    if (!cleanedBundles.includes('@deepseek-ai/dsh-web-app')) {
      cleanedBundles.splice(cleanedBundles.indexOf('@deepseek-ai/dsh-base') + 1, 0, '@deepseek-ai/dsh-web-app')
    }
    for (const name of available) {
      if (!cleanedBundles.includes(name)) cleanedBundles.push(name)
    }
    manifest.dsh.profile.bundles = cleanedBundles
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    const patchPath = join(profileDir, 'cordis.patch.yml')
    this.ensureCordisPatch(patchPath)

    const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
    if (!existsSync(workspacePath)) {
      writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    }

    for (const name of available) {
      this.ensurePluginLink(join(profileDir, 'node_modules', name), join(pluginsRoot, name))
    }
  }

  /**
   * 确保 cordis.patch.yml 处于健康状态（按当前平台/环境重写 LJANX 托管区）。
   *
   * ── Windows 上「无法选择工作区」的真实成因 ────────────────────────────────
   * 官方默认把 `directory-picker` 行挂成 dsh-host-directory-picker-auto，由它在
   * 启动时判定一次走 native 还是 browse。判定表里「绑定回环地址 + 非 SSH 启动 +
   * win32」必然判成 native；而 native 的每一次 pick 都要 spawn 一个子进程，
   * 用 koffi 在该子进程主线程里驱动 COM IFileOpenDialog。本发行版用
   * Electron-as-Node 跑内核（宿主主线程是 libuv 事件循环，没有 Win32 消息泵），
   * 该子进程会在 Show() 里直接退出而不上报结果，宿主侧报：
   *   win32 folder dialog worker exited before reporting a result
   * 用户看到的就是「点『添加工作区』没反应 / 无法选择工作区」。
   *
   * ── 为什么旧写法一次都没生效 ─────────────────────────────────────────────
   * Cordis 补丁行里的 `name` 是**一致性校验守卫**，不是覆盖字段。applyEntryPatches()
   * 先比对 `name` 与目标行当前的 `name`，不一致就整条跳过（只留一条
   * "patch: name mismatch ... skipping" 警告），并且 `name` 被单独解构出去、
   * 永远不会写进目标行。所以历史上那条
   *   - id: directory-picker
   *     name: '@deepseek-ai/dsh-host-directory-picker-browse'
   * 从未改写过 auto 行，一直是会崩的 native 选择器。
   *
   * ── 正确做法（seam 文档定义的「固定交互」）────────────────────────────────
   * 停用 auto 行，然后直接组合该交互的**两面**：host 能力行 + 对应客户端界面行。
   * 两面必须成对：只挂 host 面时，ui-workspace 占用的
   * `conversation.hero.workspace.directoryFlow` 空位无人占位（flowAvailable=false），
   * 官方 Hero 工作区选择器连「添加工作区」入口都不会渲染，依旧选不了工作区。
   */
  ensureCordisPatch(patchPath) {
    let raw = ''
    if (existsSync(patchPath)) {
      try {
        raw = readFileSync(patchPath, 'utf8')
      } catch (error) {
        console.warn(`[ServerManager] failed to read cordis.patch.yml: ${error.message}`)
      }
    }

    const groups = [this.pickerPatchLines(), clientHmrPatchLines(), webCapabilityPatchLines()].filter((group) => group.length > 0)
    const managed = groups.flatMap((group, index) => (index === 0 ? group : ['', ...group]))
    // 先把旧品牌标记升级为新标记，保证存量 profile 的旧托管区能被正确识别并整段重写
    const upgraded = raw
      .replaceAll(MANAGED_BEGIN_LEGACY, MANAGED_BEGIN)
      .replaceAll(MANAGED_END_LEGACY, MANAGED_END)
    const next = spliceManagedRegion(upgraded, managed)

    if (next !== raw) {
      try {
        writeFileSync(patchPath, next)
      } catch (error) {
        console.warn(`[ServerManager] failed to patch cordis.patch.yml: ${error.message}`)
      }
    }
  }

  /**
   * 探测已安装的 DSH 依赖树里是否真的带着浏览选择器的两面。
   * 探测不到就什么都不做、保留官方 auto 行——宁可维持原状，也不写一个半残的
   * 组合（只挂 host 面会让工作区选择器彻底失去「添加工作区」入口）。
   */
  hasBrowsePickerPackages() {
    const roots = [
      join(this.runtimePath, '../app/node_modules'),
      join(__dirname, '../../node_modules'),
      process.resourcesPath ? join(process.resourcesPath, 'node_modules') : '',
    ].filter(Boolean)
    return roots.some((root) =>
      [PICKER_BROWSE_BACKEND, PICKER_BROWSE_SURFACE].every((pkg) =>
        existsSync(join(root, ...pkg.split('/'), 'package.json')),
      ),
    )
  }

  /**
   * 目录选择器组合的补丁行（详见 ensureCordisPatch 的成因说明）。
   * 环境变量逃生门：
   *   LJANX_FORCE_BROWSE_PICKER=1 —— 任何平台都固定为应用内浏览选择器
   *     （手机/异地远程操作时原生对话框弹在无人值守的宿主屏幕上，必须用浏览面）；
   *   LJANX_FORCE_NATIVE_PICKER=1 —— 任何平台都保留官方 auto 行（愿意自己承担
   *     native 崩溃风险时使用），优先级高于前一个。
   * @returns 托管区里的补丁行（数组元素即文件行，末尾无换行）
   */
  pickerPatchLines() {
    const forceNative = process.env.LJANX_FORCE_NATIVE_PICKER === '1'
    const forceBrowse = process.env.LJANX_FORCE_BROWSE_PICKER === '1'
    const wantBrowse = !forceNative && (forceBrowse || process.platform === 'win32')

    if (!wantBrowse) return []
    if (!this.hasBrowsePickerPackages()) {
      console.warn('[ServerManager] 未在已安装的 DSH 依赖树里找到浏览选择器的两面，保留官方自适应（auto）目录选择器')
      return []
    }

    return [
      '# 停用官方自适应选择器（win32 上它必然判定为 native，而 native 的 COM',
      '# 子进程在 Electron-as-Node 宿主里会静默退出，表现为无法选择工作区）。',
      '- id: directory-picker',
      '  disabled: true',
      '',
      '# 固定为浏览交互：host 能力行 + 客户端界面行，两面必须成对出现。',
      '# 注意：不要试图用 `- id: directory-picker` + `name:` 去「覆盖」——补丁里的',
      '# name 只是校验守卫，不一致会整条跳过，永远改不动目标行的插件。',
      '- insert:',
      '    - id: directory-picker-browse',
      `      name: '${PICKER_BROWSE_BACKEND}'`,
      '',
      '    - id: directory-picker-browse-surface',
      `      name: '${PICKER_BROWSE_SURFACE}'`,
    ]
  }

  /**
   * 确保 link 是指向 target 的符号链接；指向别处的旧链接重建；
   * 真实目录/文件不破坏（可能由用户 pnpm 管理），直接跳过。
   */
  ensurePluginLink(link, target) {
    mkdirSync(dirname(link), { recursive: true })
    let stat
    try {
      stat = lstatSync(link)
    } catch {
      stat = undefined
    }
    if (stat) {
      if (!stat.isSymbolicLink()) return
      if (readlinkSync(link) === target) return
      unlinkSync(link)
    }
    try {
      symlinkSync(target, link, 'junction')
    } catch {
      try {
        cpSync(target, link, { recursive: true })
      } catch (error) {
        console.warn(`[ServerManager] failed to link plugin ${target}: ${error.message}`)
      }
    }
  }

  /**
   * Start the isolated DSH web service
   * @returns {Promise<string>} returns the web URL once ready
   */
  async start() {
    this.initIsolatedStorage()
    this.initIsolatedProfile()

    const serverUrl = `http://127.0.0.1:${this.port}`

    const nodeModulesCandidate = join(this.runtimePath, '../app/node_modules')
    const fallbackNodeModules = join(__dirname, '../../node_modules')
    const nodePath = existsSync(nodeModulesCandidate) ? nodeModulesCandidate : fallbackNodeModules

    let appVersion = '1.0.0'
    try {
      const appPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))
      if (appPkg.version) appVersion = appPkg.version
    } catch {}

    const augmentedPath = this.resolveAugmentedPath()
    const env = {
      ...process.env,
      PATH: augmentedPath,
      // 关键：告诉 Electron 二进制作为无界面的 Node.js 运行时执行，绝不递归弹出 GUI 窗口
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: nodePath,
      // 强制隔离环境变量，绝不读取日常 ~/.dsh
      DSH_HOME: this.dshHome,
      DSH_PORT: String(this.port),
      PORT: String(this.port),
      DSH_WORKSPACE: this.defaultWorkspace,
      DSH_DESKTOP_ISOLATED: '1',
      NODE_ENV: 'production',
      LJANX_VERSION: appVersion,
      ...(this.isPortable ? {
        LJANX_PORTABLE_ROOT: this.dshHome,
        DSH_IS_PORTABLE: '1',
      } : {
        LJANX_WORKSPACE_ROOT: dirname(dirname(this.defaultWorkspace)),
      }),
    }

    // 查找内置的官方 DSH 启动脚本 (bin.js)
    const packagedBin = process.resourcesPath ? join(process.resourcesPath, 'node_modules/@deepseek-ai/dsh/lib/bin.js') : ''
    const devBin = join(__dirname, '../../node_modules/@deepseek-ai/dsh/lib/bin.js')
    const binScript = existsSync(packagedBin) ? packagedBin : devBin

    if (!existsSync(binScript)) {
      console.warn(`[ServerManager] DSH core bin not found at ${binScript}.`)
      return serverUrl
    }

    this.childProcess = spawn(process.execPath, [
      '--expose-internals',
      binScript,
      'web',
      '--port', String(this.port),
      '--no-open',
    ], {
      env,
      cwd: this.defaultWorkspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuffer = ''

    const logStream = createWriteStream(this.logFile, { flags: 'a' })
    logStream.write(`\n[${new Date().toISOString()}] === DeepSeek Agent Core Starting on port ${this.port} ===\n`)

    this.authenticatedUrl = ''
    this.childProcess.stdout?.on('data', (data) => {
      const text = data.toString()
      console.log(`[DSH-Core] ${text.trim()}`)
      logStream.write(data)
      stdoutBuffer += text
      const match = stdoutBuffer.match(/dsh web:\s+(https?:\/\/[^\s\(\)]+)/i)
      if (match && !this.authenticatedUrl) {
        this.authenticatedUrl = match[1]
        console.log(`[ServerManager] Detected 0.1.2 authenticated startup URL with token: ${this.authenticatedUrl}`)
      }
    })

    this.childProcess.stderr?.on('data', (data) => {
      console.error(`[DSH-Core Error] ${data.toString().trim()}`)
      logStream.write(data)
    })

    this.childProcess.on('exit', (code, signal) => {
      console.log(`[DSH-Core] Process exited with code ${code}, signal ${signal}`)
      logStream.write(`[${new Date().toISOString()}] Process exited with code ${code}, signal ${signal}\n`)
      this.lastExitCode = code
      this.childProcess = null
    })

    // 捕获带 token 的认证 URL（判据与实测缘由见 awaitAuthToken 的注释）
    await this.awaitAuthToken(90000)

    const authenticatedUrl = this.authenticatedUrl

    if (!authenticatedUrl && this.childProcess === null) {
      const exitMsg = this.lastExitCode !== null ? `底层核心服务异常退出 (退出码: ${this.lastExitCode})` : '底层核心服务未能成功启动'
      throw new Error(exitMsg)
    }

    // 确保服务端口已就绪（判据与缘由见 awaitCoreReady 的注释）
    const ready = await this.awaitCoreReady(serverUrl, authenticatedUrl)

    if (!ready && !authenticatedUrl) {
      const exitMsg =
        this.lastExitCode !== null
          ? `底层核心服务异常退出 (退出码: ${this.lastExitCode})`
          : '服务就绪探测超时，未能建立 HTTP 连接'
      throw new Error(exitMsg)
    }

    return authenticatedUrl || serverUrl
  }

  /**
   * 等核心 stdout 打印出带 token 的认证地址（`dsh web: http://127.0.0.1:PORT/?token=...`）。
   *
   * 为什么不能按固定短窗口：历史上这里是 15 秒硬上限，超时就回退到**不带 token 的
   * 地址**。而窗口一旦 loadURL 到无 token 地址，页面只会显示
   *   dsh web authentication required; reopen the URL printed by dsh web
   * 并且**不会自愈**——正常用户根本无处拿到那个地址，等于应用打不开。
   *
   * 同一台机器、同一份产物的实测对照：
   *   · 已安装 + 系统空闲（热启动）  → 2.40s 拿到 token，窗口正常；
   *   · 全新安装后立刻启动（冷启动） → **39.75s** 才拿到 token，旧逻辑早已超时 → 白屏。
   * 冷启动慢是「杀毒软件实时扫描刚解包出来的 200MB+」+ 首次建 profile 的代价，
   * 每个新用户第一次打开都要经历一次，正好砸在最关键的路径上。
   *
   * 判据与 awaitCoreReady 保持一致：**只要子进程还活着就继续等**，真正的失败信号
   * 是子进程退出；另给总预算上限，避免核心卡死时无限挂起。预算是可注入参数，
   * 便于用纯逻辑单测覆盖（见 scripts/check-startup-readiness.mjs）。
   *
   * @param {number} [budgetMs] 总预算（毫秒）
   * @returns {Promise<boolean>} 是否在预算内捕获到带 token 的地址
   */
  async awaitAuthToken(budgetMs = 90000) {
    const startedAt = Date.now()
    while (!this.authenticatedUrl) {
      // 子进程已退出 ⇒ 不可能再打印了，快速失败，别空等预算
      if (this.childProcess === null) return false
      if (Date.now() - startedAt >= budgetMs) return false
      await new Promise((r) => setTimeout(r, 200))
    }
    return true
  }

  /**
   * 等核心 HTTP 就绪。
   *
   * 为什么不能按固定短窗口判失败：**全新安装后的第一次启动**要额外付出
   * 「杀毒软件实时扫描刚写盘的 200MB+ 文件」的代价。实测同一份产物，
   * 首次启动可超过 20 秒才就绪，而之后每次只要 2~3 秒（连全新数据目录重建
   * profile 也只要 2 秒）。若此时直接抛错，用户会在服务其实已经起来的情况下
   * 看到「后台服务未能正常就绪」弹窗，且主窗口干脆不创建 —— 恰好砸在每个
   * 新用户必经的那一次启动上。
   *
   * 判据因此改成：**只要子进程还活着就继续等**。真正的失败信号是子进程退出
   * （start() 的 exit 分支会把 this.childProcess 置空），而不是「等得不够久」。
   * 同时给一个总预算上限，避免核心卡死时无限挂起。
   *
   * @param {string} serverUrl 探测目标
   * @param {string|null} authenticatedUrl 已捕获到的带 token URL（有则直接算就绪）
   * @param {number} [budgetMs] 总预算上限（可注入，便于测试）
   * @returns {Promise<boolean>} 是否已就绪
   */
  async awaitCoreReady(serverUrl, authenticatedUrl = null, budgetMs = 90000) {
    if (authenticatedUrl) return true

    const SLICE_MS = 5000
    const readyStart = Date.now()
    let ready = false

    while (true) {
      ready = await this.waitForHttpReady(serverUrl, SLICE_MS)
      if (ready) break
      if (this.childProcess === null) break // 核心已退出，再等没有意义
      if (Date.now() - readyStart >= budgetMs) break
    }

    return ready
  }

  /**
   * Poll until HTTP endpoint responds or timeout expires
   */
  async waitForHttpReady(url, timeoutMs = 15000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(url, { method: 'HEAD' }).catch(() => null)
        if (res && (res.status === 200 || res.status === 302 || res.status === 401 || res.status === 404)) {
          return true
        }
      } catch {
        // waiting
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  /**
   * 补全子进程所需的 PATH 环境变量：
   * 1. 优先注入 App 内置的 runtime/bin 目录（最高优先级，开箱即用内置的 bsk CLI 等工具）；
   * 2. 补齐 macOS/Linux GUI 桌面应用从 Finder/Dock 启动时丢失的终端 PATH
   *    （如 /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, ~/.cargo/bin 等）；
   * 3. 保留并追加原有的 process.env.PATH。
   */
  resolveAugmentedPath() {
    return augmentGlobalPath(this.runtimePath)
  }

  /**
   * Stop & clean up child process
   */
  stop() {
    if (this.childProcess && !this.childProcess.killed) {
      try {
        this.childProcess.kill('SIGTERM')
      } catch {
        try {
          this.childProcess.kill('SIGKILL')
        } catch {}
      }
      this.childProcess = null
    }
  }
}

/** 禁用官方客户端热重载 SSE 通道，彻底避免单端口多标签连接耗尽。 */
function clientHmrPatchLines() {
  return [
    '# 禁用官方客户端热重载 SSE 通道，彻底避免单端口多标签连接耗尽。',
    '- id: client-hmr',
    '  disabled: true',
  ]
}

/**
 * web 能力行的常驻启用补丁（`dsh-web` 默认集成）。
 *
 * ── 为什么不是「加进 profile bundles」────────────────────────────────────
 * `@deepseek-ai/dsh-web` 是 `ctx.web` 的 Service 基类（`WebRuntime extends
 * Service`），不是插件包：它的 package.json 没有 `dsh.bundle` 字段。DSH 的
 * profile 组装器（dsh-app-boot 的 loadProfileDirectory）对 bundles 清单里
 * 每一项都强制要求 `dsh.bundle`，缺了就整个内核启动失败：
 *   Error: profile bundle "@deepseek-ai/dsh-web" declares no dsh.bundle
 * 所以 dsh-web 只能作为 cordis 行（host 侧能力），由 dsh-base 提供、由这里
 * 的补丁行保证启用状态。
 *
 * ── 本发行版为什么要显式启用 ───────────────────────────────────────────
 * 上游 dsh-base 已挂好 `web` / `web-search-deepseek` / `web-fetch-http` 三行，
 * 但 dsh-web-app（web 前端产品形态）会按「web 应用」的假设改动它们（如把
 * tool-web 交给各 agent preset 逐预设组装）。本发行版是原生 Electron 应用，
 * 不依赖 web 前端组装，因此在 LJANX 托管区显式声明：能力 seam 与匿名
 * 公共 HTTP(S) 抓取 provider 常驻启用，避免上游组合变化把能力行关掉。
 * 搜索 provider 由 dsh-web-search-follow 插件的 follow-search 接管
 * （合成的 config.searchProvider 保持不动，补丁只改 disabled）。
 *
 * @returns {string[]} 托管区里的 web 能力补丁行
 */
function webCapabilityPatchLines() {
  return [
    '# dsh-web：ctx.web 搜索/抓取能力（内核侧 host 行，不是前端插件）。',
    '# 本发行版是原生 Electron 应用，不依赖 web 前端组装，故显式常驻启用：',
    '#   · web            —— ctx.web 能力 seam（搜索 + 抓取统一入口）',
    '#   · web-fetch-http —— 匿名公共 HTTP(S) 抓取 provider',
    '# 搜索 provider 由 dsh-web-search-follow 的 follow-search 接管。',
    '- id: web',
    "  name: '@deepseek-ai/dsh-web'",
    '  disabled: false',
    '- id: web-fetch-http',
    "  name: '@deepseek-ai/dsh-web-fetch-http'",
    '  disabled: false',
  ]
}

/**
 * 顶层补丁行的块边界：从 `- ...` 行起，吃掉后续所有缩进内容（含块内空行）。
 * @param {string[]} lines
 * @param {number} start 起始行下标
 * @returns {number} 块结束（不含）的行下标
 */
function managedBlockEnd(lines, start) {
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() !== '' && /^\s/.test(line)) {
      i += 1
      continue
    }
    if (line.trim() === '') {
      let next = i
      while (next < lines.length && lines[next].trim() === '') next += 1
      if (next < lines.length && lines[next].trim() !== '' && /^\s/.test(lines[next])) {
        i = next
        continue
      }
    }
    break
  }
  return i
}

/**
 * 摘掉历史遗留、没有托管标记的补丁块，使托管区重写是幂等的：
 *  1. 上一版写下的托管标记区（BEGIN..END）；
 *  2. 含 directory-picker-browse* 行的顶层 `- insert:` 块；
 *  3. 顶层 `- id: <MANAGED_ROW_IDS>` 块，连同紧贴在它上方的说明注释。
 * @param {string} raw 现有补丁文件内容
 * @returns {string} 清理后的正文（去尾空格、压缩连续空行）
 */
function stripManagedBlocks(raw) {
  const lines = raw.split(/\r?\n/)
  const dropped = new Array(lines.length).fill(false)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (line.trim() === MANAGED_BEGIN) {
      let j = i
      while (j < lines.length && lines[j].trim() !== MANAGED_END) {
        dropped[j] = true
        j += 1
      }
      if (j < lines.length) dropped[j] = true
      i = j
      continue
    }

    if (/^-\s+insert:\s*$/.test(line)) {
      const end = managedBlockEnd(lines, i)
      if (/directory-picker-browse/.test(lines.slice(i, end).join('\n'))) {
        for (let j = i; j < end; j += 1) dropped[j] = true
      }
      i = end - 1
      continue
    }

    const rowMatch = line.match(/^-\s+id:\s*(\S+)\s*$/)
    if (rowMatch && MANAGED_ROW_IDS.includes(rowMatch[1])) {
      const end = managedBlockEnd(lines, i)
      for (let j = i; j < end; j += 1) dropped[j] = true
      for (let j = i - 1; j >= 0 && /^#/.test(lines[j]); j -= 1) dropped[j] = true
      i = end - 1
    }
  }

  return lines
    .filter((_, index) => !dropped[index])
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 把生成的托管区拼到清理后的正文尾部：两个标记之间永远只有生成内容，
 * 标记之外的用户内容只补不删。空的 entry 列表占位（`[]` / `---`）直接丢弃。
 * @param {string} raw 现有补丁文件内容
 * @param {string[]} managedLines 托管区补丁行
 * @returns {string} 新的补丁文件内容（以单个换行结尾）
 */
function spliceManagedRegion(raw, managedLines) {
  const body = stripManagedBlocks(raw)
  const parts = []
  if (body && body !== '[]' && body !== '---') parts.push(body)
  if (managedLines.length > 0) parts.push([MANAGED_BEGIN, ...managedLines, MANAGED_END].join('\n'))
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n'
}

/**
 * 跨平台环境补全全局 PATH：
 * 解决 macOS/Linux GUI 桌面应用双击启动时丢失 shell 环境变量的通病。
 * @param {string} [runtimePath] 可选的 bundle-runtime 根目录
 * @returns {string} 增强后的 PATH 环境变量字符串
 */
export function augmentGlobalPath(runtimePath) {
  const isWin = process.platform === 'win32'
  const delimiter = isWin ? ';' : ':'
  const home = homedir()
  const extraDirs = []

  if (runtimePath) {
    const candidates = [
      join(runtimePath, 'bin'),
      join(runtimePath, 'bin', `${process.platform}-${process.arch}`),
    ]
    for (const c of candidates) {
      if (existsSync(c) && !extraDirs.includes(c)) {
        extraDirs.push(c)
      }
    }
  }

  if (!isWin) {
    const commonPosixDirs = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      join(home, '.local', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, 'bin'),
    ]
    for (const d of commonPosixDirs) {
      if (existsSync(d) && !extraDirs.includes(d)) {
        extraDirs.push(d)
      }
    }
  } else {
    const commonWinDirs = [
      join(home, '.local', 'bin'),
      join(home, '.cargo', 'bin'),
    ]
    for (const d of commonWinDirs) {
      if (existsSync(d) && !extraDirs.includes(d)) {
        extraDirs.push(d)
      }
    }
  }

  const currentPaths = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const merged = [...extraDirs]
  for (const p of currentPaths) {
    if (!merged.includes(p)) merged.push(p)
  }

  const finalPath = merged.join(delimiter)
  process.env.PATH = finalPath
  return finalPath
}
