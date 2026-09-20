/**
 * @mlgbnb/dsh-archive-manager 归档列表补丁的回归检查（`pnpm check:archive`）。
 *
 * 为什么需要它：这个插件是第三方 npm 包，我们靠 src/main/plugin-compat.js 的字符串补丁
 * 让它跟上内核。而补丁失效的方向**不是**"少显示几行"——它的 ghost 判定会把自己的误判
 * 写回 `workspace.json` 的 `global.archivedSessionIds`，也就是**静默删掉用户的归档状态**。
 * 所以这里既查"补丁打上没有"，也拿假数据目录跑一次真实函数，验证归档会话能被列出、
 * 并且 workspace.json 一字未改。
 *
 * 两级检查：
 *  1. 文本级（总是执行，前提是找得到插件副本）：新标记在位、旧锚点已被替换干净；
 *  2. 行为级（同上）：import 打过补丁的 lib/index.js，用临时 DSH_HOME 复现现行内核的
 *     存储形态（`session-<uuid>/session.v3.jsonl.zstd` + 只有分目录投影缓存、聚合表里
 *     没有这个会话），断言列表能列出它、workspace.json 没被改写。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `\n       ${extra}`}`)
  if (!ok) failures += 1
}

const CANDIDATES = [
  process.env.ARCHIVE_PKG,
  join(root, 'bundle-runtime', 'plugins', '@mlgbnb', 'dsh-archive-manager'),
  join(root, '..', 'plugins', '@mlgbnb', 'dsh-archive-manager'),
].filter(Boolean)
const pkgDir = CANDIDATES.find((p) => existsSync(join(p, 'lib', 'index.js')))
if (!pkgDir) {
  console.log('⏭️  找不到 @mlgbnb/dsh-archive-manager 的副本（先跑 pnpm prepare-bundle），跳过本检查')
  process.exit(0)
}
const file = join(pkgDir, 'lib', 'index.js')
const src = readFileSync(file, 'utf8')
console.log(`插件副本：${pkgDir}`)

console.log('▶ 1. 补丁在位')
{
  check(src.includes('export function findSessionLogs'), '会话日志名解析器已注入')
  check(src.includes("Object.assign(sessions, legacy.tables.sessions)"), '投影缓存两个来源是合并而非二选一')
  check(!src.includes('if (legacy?.tables?.sessions && Object.keys(legacy.tables.sessions).length > 0) return legacy'),
    '旧的「聚合表非空就整份返回」已移除')
  check(src.includes('if (dataDir === undefined && !sessionMeta)'), 'ghost 判定收紧成"目录都不存在"')
  check(!src.includes("      const zstdPath = join(dataDir, 'session.jsonl.zstd')"),
    'listArchives 里写死的文件名已被替换')
  check(!src.includes('    if (!hasDataFile && !sessionMeta) {'), '旧的 hasDataFile 版 ghost 条件已不在')
  check((src.match(/const projcache = readProjcacheCompat\(\)/g) || []).length >= 2,
    '列表与详情两处调用点都用上了兼容读取器')
  check(statSync(file).size > 0 && !src.includes("join(dataDir, 'session.jsonl.zstd')"),
    '全文件不再有任何写死的旧日志文件名')
}

console.log('▶ 2. 行为：现行内核的存储形态下列出归档会话')
{
  const TMP = join(root, '.archive-check')
  rmSync(TMP, { recursive: true, force: true })
  const home = join(TMP, 'dsh-home')
  const wsPath = join(TMP, 'workspace')
  const sid = 'session-11112222-3333-4444-5555-666677778888'
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  mkdirSync(wsPath, { recursive: true })

  // 会话目录：现行内核的命名与落盘文件名
  const dataDir = join(home, 'sessions', '--T-~0000~776E--', sid)
  mkdirSync(dataDir, { recursive: true })
  const events = [
    { type: 'session', createdAt: 1789000000000, cwd: wsPath },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第一条用户消息' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手回答' }] } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'session/title', data: { title: '被归档的会话' } },
  ]
  // 不真压 zstd 的话，只能证明"文件名认得对"，证不了内容解析路径。所以这里用
  // Node 自带的 zstdCompressSync 造一份**真多帧**压缩文件（现行内核就是多帧落盘），
  // 让 hasDataFile / 标题 / 轮数 都必须从真实字节里解出来。
  const frames = [
    events.slice(0, 3).map((e) => JSON.stringify(e) + '\n').join(''),
    events.slice(3).map((e) => JSON.stringify(e) + '\n').join(''),
  ].map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8')))
  writeFileSync(join(dataDir, 'session.v3.jsonl.zstd'), Buffer.concat(frames))

  // 投影缓存只有分目录形式，聚合表里**没有**这个会话（真实机器上就是这种状态）
  writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({ tables: { sessions: {} } }))
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`), JSON.stringify({
    identity: { formatVersion: 3, createdAt: 1789000000000, cwd: wsPath },
    rows: { title: { val: '被归档的会话' }, sessionStats: { val: { turns: 2 } } },
  }))
  const workspacePath = join(home, 'storages', 'workspace.json')
  const workspaceDoc = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [sid] },
    tables: { workspaces: { w1: { path: wsPath, title: '我的工作区', sessionIds: [sid], createdAt: '', updatedAt: '2026-09-20T00:00:00.000Z' } } },
  }
  writeFileSync(workspacePath, JSON.stringify(workspaceDoc))

  process.env.DSH_HOME = home
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
  const ctx = { workspaceRegistry: { archivedSessionIds: [sid] } }
  const list = mod.listArchives(ctx)

  check(Array.isArray(list) && list.length === 1, '归档会话被列出来了（而不是被当成 ghost 抹掉）', JSON.stringify(list))
  check(list[0]?.sessionId === sid, '列出的正是那个归档 id')
  check(list[0]?.workspaceTitle === '我的工作区', '按所属工作区分组的信息也对')
  check(list[0]?.hasDataFile === true, '认得 session.v3.jsonl.zstd（hasDataFile 为真）')
  check(list[0]?.turns === 2, '轮数是从真多帧 zstd 里解出来的（2 个 turn/start）', `turns=${list[0]?.turns}`)
  check(list[0]?.createdAt === 1789000000000, '创建时间同样来自压缩文件', String(list[0]?.createdAt))
  check((list[0]?.dataSize ?? 0) > 0, '磁盘占用大小也算出来了')

  const after = JSON.parse(readFileSync(workspacePath, 'utf8'))
  check(JSON.stringify(after.global.archivedSessionIds) === JSON.stringify([sid]),
    'workspace.json 没有被改写 —— 归档状态没被插件偷偷删掉', JSON.stringify(after.global.archivedSessionIds))

  // 投影缓存完全没有行的会话（真实机器上就有这种）：只要磁盘目录在，就不该被判 ghost。
  rmSync(join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`))
  const list15 = mod.listArchives(ctx)
  check(list15.length === 1 && list15[0].sessionId === sid,
    '投影缓存整行缺失时仍能列出（磁盘目录在就不是 ghost）', JSON.stringify(list15.map((x) => x.sessionId)))
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`), JSON.stringify({
    identity: { formatVersion: 3, createdAt: 1789000000000, cwd: wsPath },
    rows: { title: { val: '被归档的会话' }, sessionStats: { val: { turns: 2 } } },
  }))

  // 真 ghost：目录不存在、缓存也没有 → 仍然应该被剪掉（收紧不等于放弃清理）
  const ghostSid = 'session-deadbeef-0000-0000-0000-000000000000'
  writeFileSync(workspacePath, JSON.stringify({
    ...workspaceDoc,
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [sid, ghostSid] },
    tables: { workspaces: { w1: { ...workspaceDoc.tables.workspaces.w1, sessionIds: [sid, ghostSid] } } },
  }))
  const list2 = mod.listArchives({ workspaceRegistry: { archivedSessionIds: [sid, ghostSid] } })
  check(list2.length === 1 && list2[0].sessionId === sid, '真 ghost（磁盘无目录且无缓存行）仍会被跳过')
  const after2 = JSON.parse(readFileSync(workspacePath, 'utf8'))
  check(!after2.global.archivedSessionIds.includes(ghostSid), '真 ghost 会被剪出 workspace.json（清理能力没被削弱）')
  check(after2.global.archivedSessionIds.includes(sid), '剪的时候不误伤正常归档会话')

  delete process.env.DSH_HOME
  rmSync(TMP, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ 归档管理补丁全部断言通过' : `\n❌ ${failures} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
