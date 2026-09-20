/**
 * 快照存储根的解析与一次性搬迁（宿主侧）。
 *
 * 背景：内置社区插件 dsh-undo-savepoint 把「配置与插件代码变更的可回滚快照」存在
 * `<DSH_HOME>/undo-snapshots/{manual,auto,blobs}` 下。它的所有落点都汇到同一个根：
 *
 *   lib/base.mjs   LEGACY_ROOT = process.env.DSH_UNDO_ROOT ?? join(DSH_HOME,'undo-snapshots')
 *                  resolveStoreRoots() → <LEGACY_ROOT>/[profile]/{manual,auto}
 *                  blobs 目录 = join(dirname(cfg.autoDir), 'blobs')   ← 运行时推导
 *                  undo-exports = dirname(LEGACY_ROOT)/undo-exports
 *
 * 所以**只要设一个 DSH_UNDO_ROOT 就能整体改址，不必给第三方插件打补丁、也不必 fork**。
 * 本模块负责两件事：把根算出来，以及把已有历史搬过去。
 *
 * 为什么根是「上次用的工作区」而不是「当前工作区」：工作区是内核运行期才有的概念
 * （记录在 storages/workspace.json），而 DSH_UNDO_ROOT 必须在**启动内核之前**定下来；
 * 宿主自己的 defaultWorkspace 只是 `~/Documents/LJANX/days/<日期>` 这种初始 cwd，
 * 跟用户在界面里选的「项目」不是一回事。于是取 updatedAt 最新的那个工作区，
 * 会话中途切换工作区不会当场跟过去，下次启动才跟。
 *
 * 已知语义代价（用户确认过的取舍）：这个插件快照的内容是**全局**配置与插件代码
 * （settings.yaml、cordis.patch.yml、profile 的 package.json、插件源码树、auto/env-vault
 * 凭据库），不是工作区里的项目文件。多工作区时，同一份全局配置会在各自目录下
 * 各存一条历史。
 */
import { cpSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 工作区里存放快照的目录名（点开头，多数文件工具默认忽略）。 */
export const UNDO_DIR_NAME = '.dsh-undo'

/** 旧根（DSH_HOME 下）与新根里都用来判定「这里有快照存储」的子目录名。 */
const STORE_PARTS = ['manual', 'auto', 'blobs']

/** 目录里是否已经有快照存储（任一子目录存在且非空）。 */
function hasStore(dir) {
  return STORE_PARTS.some((part) => {
    const p = join(dir, part)
    try {
      return statSync(p).isDirectory() && readdirSync(p).length > 0
    } catch {
      return false
    }
  })
}

/** 递归统计一个目录树的文件数与总字节数，用于搬迁后的校验。 */
function measure(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        files += 1
        bytes += statSync(p).size
      }
    }
  }
  try {
    if (statSync(dir).isDirectory()) walk(dir)
    else return { files: 1, bytes: statSync(dir).size }
  } catch {
    return { files: -1, bytes: -1 }
  }
  return { files, bytes }
}

/**
 * 从内核的工作区存储里挑出「最近用过的那个」的绝对路径。
 * @param {string} dshHome - 隔离数据目录（%APPDATA%\ljanx\dsh-data）
 * @returns {{path: string, updatedAt: string}|null}
 */
export function latestWorkspacePath(dshHome) {
  let store
  try {
    store = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
  } catch {
    return null
  }
  const table = store?.tables?.workspaces
  if (!table || typeof table !== 'object') return null
  let best = null
  for (const entry of Object.values(table)) {
    const p = typeof entry?.path === 'string' ? entry.path.trim() : ''
    if (!p) continue
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue // 工作区被删/挂载盘没插：不往不存在的路径里写快照
    const at = typeof entry.updatedAt === 'string' ? entry.updatedAt : ''
    if (!best || at >= best.updatedAt) best = { path: p, updatedAt: at }
  }
  return best
}

/**
 * 算出本次启动应该用的快照根。
 * @param {object} opts
 * @param {string} opts.dshHome - 隔离数据目录
 * @param {NodeJS.ProcessEnv} [opts.env] - 环境（用户自己钉过 DSH_UNDO_ROOT 时绝不覆盖）
 * @returns {{root: string, reason: string}} root 为空串表示不注入，插件按它自己的默认走。
 */
export function resolveUndoRoot({ dshHome, env = process.env }) {
  const pinned = typeof env?.DSH_UNDO_ROOT === 'string' ? env.DSH_UNDO_ROOT.trim() : ''
  if (pinned) return { root: '', reason: '已由环境变量 DSH_UNDO_ROOT 指定，宿主不覆盖' }

  const ws = latestWorkspacePath(dshHome)
  if (!ws) return { root: '', reason: '工作区存储里找不到可用的工作区，沿用插件默认' }

  // 多套一层 snapshots/：这样插件推导出的 undo-exports 落在 .dsh-undo/undo-exports，
  // 所有派生目录都收在同一个点目录下，不往工作区根上摊一堆兄弟目录。
  return { root: join(ws.path, UNDO_DIR_NAME, 'snapshots'), reason: `跟随最近使用的工作区 ${ws.path}` }
}

/**
 * 一次性把旧根的整体复制到新根，校验通过才把旧根改名让位。
 *
 * 为什么是"复制 + 校验 + 改名"而不是"移动"：
 *   · 旧根在 %APPDATA%（通常在 C:），新根在工作区（常在别的盘）——跨卷 rename 会 EXDEV；
 *   · 校验不过就删源等于拿用户的回滚历史赌运气。宁可留下两份，也不能丢一份。
 * 校验失败时会把半成品的新根删掉，让插件退回完整可用的旧根。
 *
 * @param {object} opts
 * @param {string} opts.from - 旧根（<DSH_HOME>/undo-snapshots）
 * @param {string} opts.to - 新根
 * @param {(msg: string) => void} [opts.log]
 * @returns {{action: string, detail?: string}}
 */
export function migrateUndoStore({ from, to, log = (m) => console.log(m) }) {
  if (!from || !to) return { action: 'skip', detail: '路径不完整' }
  if (resolve(from) === resolve(to)) return { action: 'skip', detail: '新旧根相同' }
  if (!hasStore(from)) return { action: 'skip', detail: '旧根没有快照内容，无需搬迁' }
  if (hasStore(to)) return { action: 'skip', detail: '新根已有快照存储，不动它' }

  const want = measure(from)
  try {
    cpSync(from, to, { recursive: true })
  } catch (err) {
    try {
      rmSync(to, { recursive: true, force: true })
    } catch { /* 半成品删不掉也只是留个空目录，下次启动会重试 */ }
    return { action: 'failed', detail: `复制失败：${err?.message ?? err}` }
  }

  const got = measure(to)
  if (got.files !== want.files || got.bytes !== want.bytes) {
    try {
      rmSync(to, { recursive: true, force: true })
    } catch { /* noop */ }
    return { action: 'failed', detail: `校验不一致（期望 ${want.files} 个文件 / ${want.bytes} 字节，实得 ${got.files} / ${got.bytes}），已回退到旧根` }
  }

  let retired = ''
  try {
    retired = `${from}.migrated-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    renameSync(from, retired)
  } catch {
    retired = ''
    log('[undo-store] 新根已就绪，但旧根改名失败（可能被占用）；快照会继续写在新根，旧目录请手动清理')
  }
  log(`[undo-store] 快照存储已迁到 ${to}（${got.files} 个文件 / ${got.bytes} 字节）${retired ? `，旧根让位为 ${retired}` : ''}`)
  return { action: 'migrated', detail: retired || to }
}
