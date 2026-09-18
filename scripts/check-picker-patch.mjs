/**
 * 目录选择器组合的回归守门检查（`npm run check:picker`）。
 *
 * 为什么需要它：Windows 上「无法选择工作区」的根因是一个**静默失效的补丁**。
 * Cordis 补丁行里的 `name` 是「一致性校验守卫」而不是覆盖字段——
 * applyEntryPatches() 发现 name 与目标行当前 name 不一致就整条跳过，只留一条
 * warn。历史上正是这么写的，于是「固定为 browse 选择器」这件事一年都没生效，
 * 谁也不会在日志里注意到。本脚本把「组合后到底挂了什么」变成断言。
 *
 * 两级检查：
 *  1. 结构级（总是执行）：把 profile 补丁生成到临时目录，断言它停用了 auto 行、
 *     且成对插入了浏览交互的两面；
 *  2. 组合级（依赖已安装的 DSH 时执行）：调用官方真实的 applyEntryPatches，
 *     按 bundle 顺序把官方补丁层与我们的 profile 层组合成最终 entry 树，
 *     断言生效的选择器行恰好是 browse 的两面。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ServerManager } from '../src/main/server-manager.js'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const AUTO = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSE = {
  backend: '@deepseek-ai/dsh-host-directory-picker-browse',
  surface: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
}

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `\n       ${extra}`}`)
  if (!ok) failures += 1
}

const tmp = join(root, '.picker-check')
rmSync(tmp, { recursive: true, force: true })

/**
 * 造一个隔离的 dshHome / runtimePath，并按需把浏览选择器的两面装进
 * `<runtimePath>/../app/node_modules`（与运行时 NODE_PATH 的解析路径一致），
 * 然后让 ServerManager 生成一次补丁文件。
 * @param {string} label 用例名（也用作临时子目录名）
 * @param {boolean} withPackages 是否安装浏览选择器的两面
 * @param {string} seed 预置的现有补丁内容
 * @param {{stubProbe?: boolean}} [options] stubProbe 用于把「依赖树里有没有包」
 *   这件事**钉死**：探测函数会同时看仓库根的 node_modules（开发态解析路径），
 *   而仓库根有没有这两个包取决于当前是 hoisted 还是 isolated 布局。
 *   不钉死的话，「缺包」用例会随安装布局时灵时不灵。
 */
function generate(label, withPackages, seed, options = {}) {
  const caseRoot = join(tmp, label)
  const runtimePath = join(caseRoot, 'runtime')
  mkdirSync(runtimePath, { recursive: true })
  if (withPackages) {
    for (const pkg of Object.values(BROWSE)) {
      const dir = join(caseRoot, 'app', 'node_modules', ...pkg.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: 'stub' }))
    }
  }
  const dshHome = join(caseRoot, 'dsh-home')
  mkdirSync(dshHome, { recursive: true })
  const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(dirname(patchPath), { recursive: true })
  if (seed !== undefined) writeFileSync(patchPath, seed)

  const manager = new ServerManager({ port: 3199, appDataPath: dshHome, runtimePath })
  manager.dshHome = dshHome
  if (options.stubProbe !== undefined) manager.hasBrowsePickerPackages = () => options.stubProbe
  const probed = manager.hasBrowsePickerPackages()
  manager.ensureCordisPatch(patchPath)
  return { path: patchPath, text: readFileSync(patchPath, 'utf8'), probed }
}

// 故意先写一份历史上那份「无效覆盖」，验证它会被自动纠正
const LEGACY_SEED = [
  '# Windows 环境下启用官方纯 JS 目录浏览选择器，避免原生 Win32 COM 对话框因原生模块或环境问题退出',
  '- id: directory-picker',
  "  name: '@deepseek-ai/dsh-host-directory-picker-browse'",
  '',
].join('\n')

const withPkgs = generate('with-pkgs', true, LEGACY_SEED)
const noPkgs = generate('no-pkgs', false, LEGACY_SEED, { stubProbe: false })
const generated = withPkgs.text

console.log('\n[1/2] 结构级检查（profile 补丁内容）')
console.log(generated.split('\n').map((line) => `       | ${line}`).join('\n'))

if (process.platform === 'win32' || process.env.LJANX_FORCE_BROWSE_PICKER === '1') {
  check(withPkgs.probed === true, '探测器能在依赖树里找到浏览选择器的两面（真实探测，未打桩）')
  check(/^-\s+id:\s*directory-picker\s*\n\s+disabled:\s*true\s*$/m.test(generated), 'auto 行被停用')
  check(generated.includes(BROWSE.backend), `host 能力行已写入（${BROWSE.backend}）`)
  check(generated.includes(BROWSE.surface), `客户端界面行已写入（${BROWSE.surface}）`)
  check(
    !/^-\s+id:\s*directory-picker\s*\n\s+name:/m.test(generated),
    '没有留下「- id: X + name:」这种会被整条跳过的无效覆盖写法',
  )
  console.log(
    `       ℹ️  手机远程中转行（dsh-mobile-plus）：${generated.includes('dsh-mobile-plus') ? '已注入' : '未注入（未配置远程中转，符合预期）'}`,
  )

  // 最高风险失败模式：包缺失时若仍写 `disabled: true`，就会从「选择器不工作」
  // 恶化成「一个选择器都没有」。必须整体退化、保留官方 auto 行。
  // 这一用例把「依赖树里有没有包」的探测结果钉死为 false：
  // 探测器同时会看仓库根的 node_modules（开发态解析路径），而那里有没有这两个包
  // 取决于当前是 hoisted 还是 isolated 布局，不钉死就会随安装方式时灵时不灵。
  console.log('\n       ── 退化用例：依赖树里没有浏览选择器两面（探测结果已打桩为 false）──')
  console.log(noPkgs.text.split('\n').map((line) => `       | ${line}`).join('\n'))
  check(!noPkgs.text.includes(BROWSE.backend), '缺包时不写入 host 能力行')
  check(
    !/^-\s+id:\s*directory-picker\s*\n\s+disabled:\s*true\s*$/m.test(noPkgs.text),
    '缺包时不停用 auto 行（绝不让选择器彻底消失）',
  )
  // 缺包时历史遗留的无效覆盖写法仍会被清掉，但必须有一份合法的降级结果
  check(
    noPkgs.text.includes('client-hmr'),
    '缺包时其他托管行（client-hmr）仍正常写入',
  )
} else {
  check(true, `当前平台 ${process.platform} 保留官方自适应选择器（本脚本在该平台只做结构校验）`)
}
check(generated.includes('# 禁用官方客户端热重载 SSE 通道'), 'client-hmr 禁用行仍在托管区')

console.log('\n[2/2] 组合级检查（官方 applyEntryPatches 实测）')
const resolvable = (spec) => {
  try {
    return require.resolve(spec)
  } catch {
    return null
  }
}
const includePath = resolvable('@deepseek-ai/cordis-plugin-include')
const basePatchPath = resolvable('@deepseek-ai/dsh-base/cordis.patch.yml')
const webAppPatchPath = resolvable('@deepseek-ai/dsh-web-app/cordis.patch.yml')

if (!includePath || !basePatchPath || !webAppPatchPath) {
  console.log('  ⏭️  跳过：需要先安装依赖（缺少 cordis-plugin-include / dsh-base / dsh-web-app）')
} else {
  try {
    // require.resolve() 在 Windows 上返回 `g:/...` 这类裸绝对路径，
    // 它不是合法的 ESM URL（只有 file:/data:/node: 三种 scheme 被接受），
    // 必须用 pathToFileURL() 包装后再 import。
    const { applyEntryPatches, entryListSchema } = await import(pathToFileURL(includePath).href)
    const { load } = await import('js-yaml')
    const layerOf = (file) => load(readFileSync(file, 'utf8'), { schema: entryListSchema })
    const layers = [layerOf(basePatchPath), layerOf(webAppPatchPath), layerOf(withPkgs.path)]
    const tree = layers.reduce((data, patches) => applyEntryPatches(data, patches, () => {}), [])
    const pickerRows = tree.filter((entry) => /directory-picker/.test(String(entry.name ?? '')))
    const active = pickerRows.filter((entry) => !entry.disabled)
    console.log(
      pickerRows
        .map((entry) => `       · id=${entry.id} name=${entry.name}${entry.disabled ? ' [disabled]' : ''}`)
        .join('\n'),
    )

    check(
      pickerRows.some((entry) => entry.name === AUTO && entry.disabled === true),
      'auto 行在最终 entry 树里处于停用状态',
    )
    check(
      active.length === 2 && active.some((entry) => entry.name === BROWSE.backend) && active.some((entry) => entry.name === BROWSE.surface),
      '生效的选择器行恰好是 browse 的两面（不是 0 条，也不是 3 条）',
      `实际生效 ${active.length} 条`,
    )

    // 官方 auto 包的 README 明确警告：重复挂载会以「重复的 directoryPicker 服务 /
    // single 槽位重复流程」报错。整棵树里 id 与「服务提供者」都必须是独一份。
    const idCounts = new Map()
    for (const entry of tree) {
      if (entry.id === undefined) continue
      idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1)
    }
    const dupIds = [...idCounts].filter(([, n]) => n > 1)
    check(dupIds.length === 0, '最终 entry 树里没有重复的 id', dupIds.map(([id, n]) => `${id} ×${n}`).join(', '))

    const providers = new Map()
    for (const entry of active) {
      if (entry.name === undefined) continue
      providers.set(entry.name, (providers.get(entry.name) ?? 0) + 1)
    }
    const dupProviders = [...providers].filter(([, n]) => n > 1)
    check(
      dupProviders.length === 0,
      '生效行里没有重复的插件（杜绝重复挂载同一能力）',
      dupProviders.map(([name, n]) => `${name} ×${n}`).join(', '),
    )
  } catch (error) {
    check(false, '组合级检查自身执行成功', String(error?.stack ?? error))
  }
}

rmSync(tmp, { recursive: true, force: true })

if (failures === 0) {
  console.log('\n🎉 目录选择器组合检查通过')
  process.exit(0)
}
console.error(`\n⚠️ 目录选择器组合检查失败：${failures} 条断言未通过`)
process.exit(1)
