/**
 * 更新轨道（正式版 / 纯净版）分离的回归检查（`pnpm check:updater`）。
 *
 * 为什么需要：这个发行版有两条交付轨 —— main 分支出正式版（`v1.4.3`），
 * vanilla 分支出纯净版（`v1.4.3-vanilla.1`，GitHub 上是 prerelease）。两条轨共用
 * 同一个 appId、同一个产品名、同一个 `DeepSeek-Agent-<version>-...` 资产名规则，
 * 所以**光看包名和安装位置根本分不出彼此**。而 v1.4.3 之前的更新器只查
 * `/releases/latest` + atom 里 `isStableVersion` 过滤，于是纯净版用户一旦点
 * 「检查更新」，拿到的就是 260MB 的全插件正式版包 —— 这正是本门禁要钉死的串台。
 *
 * 三组结论，缺一不可：
 *   1. 轨道判定：装的是哪条轨、release 属于哪条轨（非 vanilla 的 prerelease 两边都不给）
 *   2. 查询分轨：正式轨走 /releases/latest，纯净轨必须走 /releases 列表
 *      （GitHub 那个 latest 端点结构上永不返回 prerelease，纯净轨查它必然查不到东西）
 *   3. 跨轨不得直接安装：跨轨结果里 asset 必须是 null，改由面板引导「先卸载旧版本」
 *      （`1.4.3-vanilla.1` 按 semver 比 `1.4.3` 是降级，用版本号大小判这条路毫无意义）
 *
 * 注：atom 兜底分支在这里只用假 payload 断言。本机到 github.com（网站域名）当前
 * 不通（`api.github.com` 通），所以那条路**无法**靠现网验证，别把它写成已验证。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tracks = await import(pathToFileURL(join(root, 'src', 'main', 'update-tracks.js')).href)

let failures = 0
let checked = 0
const ok = (cond, what) => {
  checked += 1
  if (!cond) { failures += 1; console.log(`  ❌ ${what}`) } else console.log(`  ✅ ${what}`)
}
const group = (title) => console.log(`\n── ${title}`)

// ---------------------------------------------------------------- 假数据
// 字段形态取自 2026-09-22 对 api.github.com 的真实抓取：
//   v1.4.3-vanilla.1 | prerelease=true  | DeepSeek-Agent-1.4.3-vanilla.1-Windows-Setup.exe
//   v1.4.3           | prerelease=false | DeepSeek-Agent-1.4.3-Windows-Setup.exe
function apiRelease({ tag, prerelease = false, version = tag.replace(/^v/, ''), body = '说明' } = {}) {
  return {
    tag_name: tag,
    prerelease,
    draft: false,
    html_url: `https://github.com/poying2018/deepseek-agent/releases/tag/${tag}`,
    body,
    published_at: '2026-09-22T00:00:00Z',
    assets: [
      { name: `DeepSeek-Agent-${version}-Windows-Setup.exe`, size: 100, browser_download_url: `https://example.invalid/${version}-win.exe` },
      { name: `DeepSeek-Agent-${version}-Mac-arm64.dmg`, size: 200, browser_download_url: `https://example.invalid/${version}-mac.dmg` },
      { name: `DeepSeek-Agent-${version}-Mac-arm64.dmg.blockmap`, size: 3, browser_download_url: 'https://example.invalid/blockmap' },
    ],
  }
}

function fakeFetch(routes) {
  const calls = []
  const fn = async (url) => {
    calls.push(String(url))
    for (const [pattern, responder] of routes) {
      if (!String(url).includes(pattern)) continue
      const value = typeof responder === 'function' ? responder() : responder
      if (value instanceof Error) throw value
      return {
        ok: value.status ? value.status === 200 : true,
        status: value.status || 200,
        headers: { get: () => value.headers?.['content-length'] ?? null },
        json: async () => value.json,
        text: async () => value.text,
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  // 让门禁能断言"有没有多打一次端点"（配额从 60 次/小时/IP 来的，别翻倍）
  fn.calls = () => calls.slice()
  return fn
}

const atomFeed = (tags) => `<?xml version="1.0" encoding="UTF-8"?>\n<feed>\n${tags
  .map((tag) => `  <entry><title>${tag} Release</title><link href="https://github.com/poying2018/deepseek-agent/releases/tag/${tag}"/>\n<content type="html">&lt;p&gt;${tag} 的更新说明&lt;/p&gt;</content></entry>`)
  .join('\n')}\n</feed>`

const WIN = { platform: 'win32', arch: 'x64' }

// ---------------------------------------------------------------- 1. 轨道判定
group('1. 轨道判定：装的是哪条轨')
ok(tracks.detectTrack('1.4.3') === tracks.TRACK_STABLE, '正式版号 1.4.3 → 正式轨')
ok(tracks.detectTrack('1.4.3-vanilla.1') === tracks.TRACK_VANILLA, '1.4.3-vanilla.1 → 纯净轨')
ok(tracks.detectTrack('v1.4.3-vanilla.2') === tracks.TRACK_VANILLA, '带 v 前缀同样识别为纯净轨')
ok(tracks.detectTrack('0.1.5-rc.2') === tracks.TRACK_STABLE, '非 vanilla 的 prerelease 保守归正式轨（宁漏提示不误推 260MB 全插件包）')
ok(tracks.detectTrack('not-a-version') === tracks.TRACK_STABLE, '版本号解析不出来时归正式轨')
ok(tracks.detectTrack(undefined) === tracks.TRACK_STABLE, '版本号缺失也不抛异常')
ok(tracks.detectTrack('1.4.3-vanillaX') === tracks.TRACK_STABLE, 'vanilla 必须是独立的一段标识符，vanillaX 不算')

group('1b. 轨道判定：release 属于哪条轨')
ok(tracks.releaseTrack('v1.4.3', false) === tracks.TRACK_STABLE, 'v1.4.3 + prerelease=false → 正式轨')
ok(tracks.releaseTrack('v1.4.3-vanilla.1', true) === tracks.TRACK_VANILLA, 'v1.4.3-vanilla.1 + prerelease=true → 纯净轨')
ok(tracks.releaseTrack('v1.4.3-rc.2', true) === null, 'rc 这类 prerelease 不属于任何一条轨（两边都不能推给用户）')
ok(tracks.releaseTrack('v1.4.3', true) === null, '正式版号却被标成 prerelease → 不认（防止手工勾错把半成品推给正式轨）')
ok(tracks.releaseTrack('v1.4.3-vanilla.1', false) === tracks.TRACK_VANILLA, 'tag 里带 -vanilla 就归纯净轨，哪怕 prerelease 标志漏勾')
ok(tracks.releaseTrack('LJANX-9.14.23', false) === null, '不合 semver 的历史 tag 不属于任何轨')

group('1c. 版本号比较（跨轨不看大小，但同轨降级判定要看）')
ok(tracks.compareSemver('1.4.3', '1.4.3-vanilla.1') > 0, '同版本号时正式版 > 纯净版 —— 所以跨轨装过去是降级')
ok(tracks.compareSemver('1.4.4-vanilla.1', '1.4.3-vanilla.1') > 0, '纯净轨内部小版本号仍然正常可比')

// ---------------------------------------------------------------- 2. 列表挑选
group('2. 从 /releases 列表里按轨挑选')
const mixedList = [
  apiRelease({ tag: 'v1.4.3-vanilla.1', prerelease: true, version: '1.4.3-vanilla.1' }),
  apiRelease({ tag: 'v1.4.3', version: '1.4.3' }),
  apiRelease({ tag: 'v1.4.3-rc.9', prerelease: true, version: '1.4.3-rc.9' }),
  apiRelease({ tag: 'v1.4.2', version: '1.4.2' }),
]
ok(tracks.pickReleaseForTrack(mixedList, tracks.TRACK_STABLE)?.tag_name === 'v1.4.3',
  '正式轨在一堆 prerelease 里挑到 v1.4.3（而不是排在最前的纯净版）')
ok(tracks.pickReleaseForTrack(mixedList, tracks.TRACK_VANILLA)?.tag_name === 'v1.4.3-vanilla.1',
  '纯净轨挑到纯净轨自己的最新 release')
ok(tracks.pickReleaseForTrack([apiRelease({ tag: 'v1.5.0-rc.1', prerelease: true, version: '1.5.0-rc.1' })], tracks.TRACK_VANILLA) === null,
  '纯净轨列表里只有 rc 时返回 null，绝不拿 rc 顶替')
ok(tracks.pickReleaseForTrack([], tracks.TRACK_STABLE) === null, '空列表返回 null 不抛异常')

// ---------------------------------------------------------------- 3. 同轨查询
group('3. 同轨查询（默认轨道 = 装的那条轨）')
{
  // 纯净版用户点「检查更新」，GitHub 那边同时挂着 260MB 的正式版：
  // 这是本次改动的核心回归点 —— 不传 track 时绝不能落到正式轨上。
  const fetchImpl = fakeFetch([
    ['/releases?', { json: [apiRelease({ tag: 'v1.4.4-vanilla.1', prerelease: true, version: '1.4.4-vanilla.1' }), apiRelease({ tag: 'v1.4.3', version: '1.4.3' })] }],
    ['/releases/latest', { json: apiRelease({ tag: 'v1.4.3', version: '1.4.3' }) }],
  ])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.3-vanilla.1', fetchImpl, ...WIN })
  ok(r.ok === true && r.status === 'available', '纯净版用户能看到纯净版有新版本')
  ok(r.latestVersion === '1.4.4-vanilla.1', `纯净轨报出来的版本号是纯净版（实际：${r.latestVersion}）`)
  ok(r.track === tracks.TRACK_VANILLA && r.installedTrack === tracks.TRACK_VANILLA, '结果标注当前轨道与安装轨道一致')
  ok(r.asset?.name === 'DeepSeek-Agent-1.4.4-vanilla.1-Windows-Setup.exe', `纯净轨安装包名带 prerelease 段（实际：${r.asset?.name}）`)
  ok(r.crossTrack === false && r.requiresUninstall === false, '同轨更新不需要卸载')
}
{
  const fetchImpl = fakeFetch([['/releases/latest', { json: apiRelease({ tag: 'v1.4.3', version: '1.4.3' }) }]])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.2', fetchImpl, ...WIN })
  ok(r.ok === true && r.status === 'available' && r.latestVersion === '1.4.3', '正式版用户走 /releases/latest 拿到正式版')
  ok(r.asset?.name === 'DeepSeek-Agent-1.4.3-Windows-Setup.exe', '正式轨安装包名与 artifactName 规则一致')
  ok(fetchImpl.calls().filter((u) => u.includes('/releases?')).length === 0,
    '正式轨不额外请求列表端点（沿用一次请求的旧行为，别把配额翻倍）')
}
{
  const fetchImpl = fakeFetch([['/releases/latest', { json: apiRelease({ tag: 'v1.4.3', version: '1.4.3' }) }]])
  const r = await tracks.checkForUpdates({ currentVersion: '1.5.0', fetchImpl, ...WIN })
  ok(r.status === 'latest', '已装版本比线上新（降级/自编译）时报「已是最新」，不推安装')
  ok(r.asset === null, '报「已是最新」时不携带 asset')
}
{
  const fetchImpl = fakeFetch([['/releases/latest', { status: 404 }]])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.2', fetchImpl, ...WIN })
  ok(r.status === 'no-release', '仓库还没发版 → no-release（沿用旧语义）')
}

// ---------------------------------------------------------------- 4. 跨轨查询
group('4. 跨轨查询：只给指引，不给安装包')
{
  const fetchImpl = fakeFetch([
    ['/releases?', { json: [apiRelease({ tag: 'v1.4.3-vanilla.1', prerelease: true, version: '1.4.3-vanilla.1' })] }],
  ])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.3', track: tracks.TRACK_VANILLA, fetchImpl, ...WIN })
  ok(r.ok === true && r.status === 'cross-track', '正式版用户切到纯净轨 → cross-track')
  ok(r.asset === null, '跨轨结果不得携带可下载资产（面板没有「立即安装」这条路）')
  ok(r.requiresUninstall === true, '跨轨结果标注「需先卸载旧版本」')
  ok(r.latestVersion === '1.4.3-vanilla.1', '跨轨时仍告诉用户目标轨最新是哪个版本')
  ok(r.installedTrack === tracks.TRACK_STABLE && r.track === tracks.TRACK_VANILLA, '两个轨道字段都要在结果里，面板才能说清"从哪到哪"')
}
{
  // 反向：纯净版用户切到正式轨。目标是降级（正式轨没有比 vanilla 更高的正式版号）也必须走卸载
  const fetchImpl = fakeFetch([['/releases/latest', { json: apiRelease({ tag: 'v1.4.3', version: '1.4.3' }) }]])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.3-vanilla.1', track: tracks.TRACK_STABLE, fetchImpl, ...WIN })
  ok(r.status === 'cross-track' && r.requiresUninstall === true, '纯净版切到正式轨同样按跨轨处理（哪怕版本号看起来一样）')
  ok(r.asset === null, '反向跨轨也不给安装包')
}
{
  // 目标轨还没发过任何 release：不能退回"已是最新"骗人
  const fetchImpl = fakeFetch([['/releases?', { json: [apiRelease({ tag: 'v1.4.3', version: '1.4.3' })] }]])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.3', track: tracks.TRACK_VANILLA, fetchImpl, ...WIN })
  ok(r.status === 'no-release-for-track', `目标轨还没发布过时单独报 no-release-for-track（实际：${r.status}）`)
  ok(r.asset === null, '没有对应包时不携带资产')
}

// ---------------------------------------------------------------- 5. atom 兜底
group('5. atom 兜底（假 payload，本机无法现网验证）')
{
  const fetchImpl = fakeFetch([
    ['api.github.com', new Error('403 forbidden')],
    ['releases.atom', { text: atomFeed(['v1.4.3-vanilla.1', 'v1.4.3', 'v1.4.3-rc.9', 'v1.4.2']) }],
  ])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.2', fetchImpl, ...WIN })
  ok(r.ok === true && r.source === 'atom', 'API 挂掉时回落到 atom')
  ok(r.latestVersion === '1.4.3', '正式轨兜底时挑正式版最新（排除 rc 与 vanilla）')
  ok(r.asset?.url?.includes('/releases/download/v1.4.3/DeepSeek-Agent-1.4.3-Windows-Setup.exe'),
    '兜底路径按确定性规则拼资产 URL')
}
{
  const fetchImpl = fakeFetch([
    ['api.github.com', new Error('403 forbidden')],
    ['releases.atom', { text: atomFeed(['v1.4.3', 'v1.4.2', 'v1.4.3-vanilla.1']) }],
  ])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.2-vanilla.9', fetchImpl, ...WIN })
  ok(r.ok === true && r.latestVersion === '1.4.3-vanilla.1', `纯净轨兜底只认 vanilla tag，不被列表里更靠前的正式版带偏（实际：${r.latestVersion}）`)
  ok(r.status === 'available', '纯净轨兜底照常报可更新')
  ok(r.asset?.name === 'DeepSeek-Agent-1.4.3-vanilla.1-Windows-Setup.exe', '纯净轨兜底拼出带 prerelease 段的包名')
}
{
  const fetchImpl = fakeFetch([
    ['api.github.com', new Error('down')],
    ['releases.atom', { text: atomFeed(['v1.4.3-rc.1']) }],
  ])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.2', fetchImpl, ...WIN })
  ok(r.status === 'no-release', 'feed 里只有 rc 时结论是「还没发版」，不把 rc 推给用户')
}
{
  const fetchImpl = fakeFetch([
    ['api.github.com', new Error('down')],
    ['releases.atom', new Error('down')],
  ])
  const r = await tracks.checkForUpdates({ currentVersion: '1.4.2', fetchImpl, ...WIN })
  ok(r.ok === false && typeof r.error === 'string', '两条路都不通时报错而不是假装「已是最新」')
}

// ---------------------------------------------------------------- 6. 资产名规则
group('6. 资产名与安装器约定')
ok(tracks.expectedAssetName('1.4.3-vanilla.1', 'win32', 'x64') === 'DeepSeek-Agent-1.4.3-vanilla.1-Windows-Setup.exe',
  'win 资产名：prerelease 段原样跟在版本号后面')
ok(tracks.expectedAssetName('1.4.3-vanilla.1', 'darwin', 'arm64') === 'DeepSeek-Agent-1.4.3-vanilla.1-Mac-arm64.dmg',
  'mac 资产名同上')
ok(tracks.pickInstallerAsset(apiRelease({ tag: 'v1.4.3', version: '1.4.3' }).assets, 'win32', 'x64')?.name === 'DeepSeek-Agent-1.4.3-Windows-Setup.exe',
  '从资产列表里挑包时排除 .blockmap')
{
  // 别的产品遗留资产（历史踩过：LJANX-9.14.23-Mac-arm64.dmg 被当成自己的更新包）
  const foreign = [{ name: 'LJANX-9.14.23-Windows-Setup.exe', browser_download_url: 'https://x/y' }]
  ok(tracks.pickInstallerAsset(foreign, 'win32', 'x64') === null, '产品前缀不匹配的资产一律不认')
}

// ---------------------------------------------------------------- 7. 单一真相
group('7. 接线：轨道判定只能有一套')
{
  const read = (rel) => { try { return readFileSync(join(root, rel), 'utf8') } catch { return '' } }
  const updater = read('src/main/updater.js')
  ok(/from '\.\/update-tracks\.js'/.test(updater), 'updater.js 从 update-tracks.js 引入判定与查询')
  ok(!/releases\/latest/.test(updater), 'updater.js 里不再出现端点常量（否则改一处漏一处）')
  ok(!/function parseSemver/.test(updater), 'updater.js 里不再自带第二套 semver 实现')
  ok(/isStableVersion|tagTrack/.test(read('src/main/update-tracks.js')), '过滤规则集中在 update-tracks.js 一处')

  const main = read('src/main/index.js')
  const checkHandler = main.slice(main.indexOf("ipcMain.handle('ljanx:update-check'"))
  ok(/track/.test(checkHandler.slice(0, 600)), '主进程 update-check handler 把面板选的轨道传给查询（否则面板切轨无效）')
  ok(/ljanx:update-open-uninstall/.test(main), '主进程提供「打开系统卸载入口」的 IPC（跨轨引导的落点）')

  const preload = read('src/preload/preload.cjs')
  ok(/check:\s*\(track\)/.test(preload), 'preload 的 update.check 接收轨道参数')
  ok(/openUninstall/.test(preload), 'preload 暴露 openUninstall 给面板')

  // 面板是纯浏览器侧模块（window.__ModuleLoader__），node 里 import 不动，
  // 所以这里只钉"必须存在这几个行为"，具体渲染由副本截图核对。
  const client = read('builtin-plugins/dsh-update-check/client.js')
  ok(/'cross-track'/.test(client), '面板认得 cross-track，不会把跨轨结果当成「已是最新」糊过去')
  ok(/setPhase\('cross'\)/.test(client), '面板给跨轨单独一个阶段（才会走独立的按钮组）')
  ok(/update\.check\([a-zA-Z_$]/.test(client), '面板把要查的轨道作为实参传给 update.check（不许退回无参调用）')
  ok(/update\.openUninstall\(\)/.test(client), '面板的「先卸载旧版本」按钮真的调到主进程')
  ok(!/download\(.*cross/i.test(client), '面板没有为跨轨结果准备下载入口')
  // 截图实测出来的两条（不是凭空加的规矩）：
  //   1. 本主题里 --dsw-alias-brand-primary 接近白色，拿它当胶囊背景 + 白字 = 看不见；
  //   2. 跨轨屏里再塞一坨 200px 高、属于**另一条轨**的更新说明，会把「打开系统卸载
  //      入口」这个唯一的主动作挤出可视区，而且让人误以为那是给自己的更新。
  ok(!/brand-primary\)\s*;\s*color:var\(--dsw-alias-on-brand/.test(client),
    '轨道胶囊选中态不得用 brand-primary 当背景（该主题下接近白色，白字会糊成一片）')
  const notesCond = (client.match(/\(phase === 'available'[^\n]*/) || [''])[0]
  ok(notesCond.length > 0 && !notesCond.includes("'cross'"),
    '跨轨屏不渲染另一条轨的更新说明，避免把主行动按钮挤出可视区')
}

// ---------------------------------------------------------------- 结果
console.log(`\n${failures === 0 ? '✅' : '❌'} check:updater —— ${checked - failures}/${checked} 条通过`)
process.exit(failures === 0 ? 0 : 1)
