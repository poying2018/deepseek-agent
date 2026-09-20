/**
 * 快照存储根改址的回归检查（`pnpm check:undo`）。
 *
 * 为什么需要它：这段代码动的是**用户的回滚历史**。搬迁逻辑写错的最坏结果不是
 * "快照没搬过去"，而是"旧的一份被删了、新的一份是半截的"。而且它只在下次启动时
 * 跑一次，坏了也不会立刻有人发现。所以把解析与搬迁都变成断言，用临时目录跑真函数。
 *
 * 两级检查：
 *  1. 宿主侧（总是执行）：工作区挑选、环境变量优先级、搬迁的成功/跳过/回退三条路径；
 *  2. 插件侧（依赖 dsh-undo-savepoint 的构建产物）：真的去 import 插件的 lib/base.mjs，
 *     断言它在我们注入 DSH_UNDO_ROOT 之后，把 manual/auto/blobs/exports 全部算到新根下面
 *     —— 这一条才是"不用 fork 第三方插件也能改址"这个前提的实证。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { latestWorkspacePath, migrateUndoStore, resolveUndoRoot, UNDO_DIR_NAME } from '../src/main/undo-store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok || !extra ? '' : `\n       ${extra}`}`)
  if (!ok) failures += 1
}

const TMP = join(root, '.undo-check')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/** 造一个假的 dshHome，可选地写入工作区存储与旧快照根。 */
function fixture(name, { workspaces = null, oldStore = null } = {}) {
  const home = join(TMP, name)
  mkdirSync(join(home, 'storages'), { recursive: true })
  if (workspaces) writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify(workspaces))
  if (oldStore) {
    for (const [rel, content] of Object.entries(oldStore)) {
      const p = join(home, 'undo-snapshots', rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
    }
  }
  return home
}
const wsStore = (entries) => ({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: entries.map((e) => e.id) },
  tables: { workspaces: Object.fromEntries(entries.map((e) => [e.id, { path: e.path, title: e.title, updatedAt: e.at, sessionIds: [] }])) },
})
const tree = (dir) => {
  const out = []
  const walk = (d, base) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), rel)
      else out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

console.log('▶ 1. 选哪个工作区')
{
  const wsNew = join(TMP, 'ws-new')
  const wsOld = join(TMP, 'ws-old')
  const wsGone = join(TMP, 'ws-does-not-exist')
  mkdirSync(wsNew, { recursive: true })
  mkdirSync(wsOld, { recursive: true })
  const home = fixture('pick', { workspaces: wsStore([
    { id: 'a', path: wsOld, title: '旧', at: '2026-09-01T00:00:00.000Z' },
    { id: 'b', path: wsNew, title: '新', at: '2026-09-19T00:00:00.000Z' },
    { id: 'c', path: wsGone, title: '已删', at: '2026-12-31T00:00:00.000Z' },
  ]) })
  check(latestWorkspacePath(home)?.path === wsNew, '取 updatedAt 最新且真实存在的工作区')
  check(latestWorkspacePath(home) !== null && !latestWorkspacePath(home).path.includes('does-not-exist'),
    '指向已删除目录的工作区不会被选中（最新那条正是它时也一样退到次新）')

  const r = resolveUndoRoot({ dshHome: home, env: {} })
  check(r.root === join(wsNew, UNDO_DIR_NAME, 'snapshots'), '根路径 = <工作区>/.dsh-undo/snapshots', r.root)
  check(r.root.includes('.dsh-undo'), '派生的 undo-exports 会落在同一个点目录下')

  const pinned = resolveUndoRoot({ dshHome: home, env: { DSH_UNDO_ROOT: 'D:/mine' } })
  check(pinned.root === '', '用户自己钉了 DSH_UNDO_ROOT 时宿主绝不覆盖')
  check(/环境变量/.test(pinned.reason), '覆盖被拒时给出可读理由')

  check(latestWorkspacePath(join(TMP, 'nope')) === null, '没有 workspace.json → 不报错，返回 null')
  const broken = fixture('broken')
  writeFileSync(join(broken, 'storages', 'workspace.json'), '{ 不是 json')
  check(latestWorkspacePath(broken) === null, 'workspace.json 损坏 → 返回 null（宁可沿用旧默认）')
  const emptyStore = fixture('emptystore', { workspaces: { tables: {} } })
  check(resolveUndoRoot({ dshHome: emptyStore, env: {} }).root === '', '工作区表为空 → 不注入，走插件默认')
}

console.log('▶ 2. 搬迁：成功路径')
{
  const home = fixture('mig', { oldStore: {
    'manual/20260101-000000-aaaa/manifest.json': '{"id":"a"}',
    'manual/20260101-000000-aaaa/home-settings.yaml': 'a: 1\n',
    'auto/20260102-000000-bbbb/manifest.json': '{"id":"b"}',
    'auto/boot-state.json': '{"ok":true}',
    'auto/env-vault/home-.credentials.yaml': 'secret: REDACTED\n',
    'blobs/ab/abcdef01': 'blobby',
  } })
  const from = join(home, 'undo-snapshots')
  const to = join(home, 'ws-target', UNDO_DIR_NAME, 'snapshots')
  mkdirSync(join(home, 'ws-target'), { recursive: true })
  const before = tree(from)
  const res = migrateUndoStore({ from, to, log: () => {} })
  check(res.action === 'migrated', `搬迁报告成功（${res.action}）`)
  check(JSON.stringify(tree(to)) === JSON.stringify(before), '新根里的文件树与旧根逐一对应', `${tree(to).length} vs ${before.length}`)
  check(readFileSync(join(to, 'auto', 'env-vault', 'home-.credentials.yaml'), 'utf8').includes('REDACTED'),
    '连 env-vault 这类嵌套内容也完整过去')
  check(!existsSync(from), '旧根已让位（改名，不是删除）')
  const retired = readdirSync(home).find((x) => x.startsWith('undo-snapshots.migrated-'))
  check(!!retired && tree(join(home, retired)).length === before.length, '旧根以 .migrated-<时间> 保留，内容一字不少')

  const again = migrateUndoStore({ from: join(home, 'undo-snapshots'), to, log: () => {} })
  check(again.action === 'skip', '再跑一次是幂等的（旧根已不存在 → skip）')
}

console.log('▶ 3. 搬迁：不该动手的场合')
{
  const empty = fixture('empty')
  mkdirSync(join(empty, 'undo-snapshots', 'manual'), { recursive: true })
  const to1 = join(empty, 'ws', UNDO_DIR_NAME, 'snapshots')
  mkdirSync(join(empty, 'ws'), { recursive: true })
  check(migrateUndoStore({ from: join(empty, 'undo-snapshots'), to: to1, log: () => {} }).action === 'skip',
    '旧根只有空目录 → 不搬（免得把"从没有过快照"当成搬迁过）')

  const both = fixture('both', { oldStore: { 'auto/x.json': '{}' } })
  const to2 = join(both, 'ws', UNDO_DIR_NAME, 'snapshots')
  mkdirSync(join(to2, 'auto'), { recursive: true })
  writeFileSync(join(to2, 'auto', 'keepme.json'), 'KEEP')
  const r2 = migrateUndoStore({ from: join(both, 'undo-snapshots'), to: to2, log: () => {} })
  check(r2.action === 'skip', '新根已有存储 → 绝不覆盖')
  check(readFileSync(join(to2, 'auto', 'keepme.json'), 'utf8') === 'KEEP', '新根内容原样保留')
  check(existsSync(join(both, 'undo-snapshots', 'auto', 'x.json')), '旧根也不动')

  const same = fixture('same', { oldStore: { 'auto/x.json': '{}' } })
  check(migrateUndoStore({ from: join(same, 'undo-snapshots'), to: join(same, 'undo-snapshots'), log: () => {} }).action === 'skip',
    '新旧根相同 → skip（不会自己搬到自己身上）')
}

console.log('▶ 4. 搬迁：失败必须退回旧根')
{
  const home = fixture('fail', { oldStore: { 'auto/x.json': '{}', 'blobs/ab/abcdef': 'data' } })
  const from = join(home, 'undo-snapshots')
  const to = join(home, 'ws', UNDO_DIR_NAME, 'snapshots')
  mkdirSync(join(home, 'ws', UNDO_DIR_NAME), { recursive: true })
  writeFileSync(to, '我是个文件，不是目录') // 让 cpSync 必然失败
  const res = migrateUndoStore({ from, to, log: () => {} })
  check(res.action === 'failed', '复制失败时如实报告（而不是假装搬完）')
  check(!existsSync(to), '半成品的新根被清掉，免得插件看到半截存储')
  check(existsSync(join(from, 'auto', 'x.json')) && existsSync(join(from, 'blobs', 'ab', 'abcdef')),
    '旧根一字未动 —— 历史还在')
}

console.log('▶ 5. 插件侧实证：注入 DSH_UNDO_ROOT 之后它真的换根')
{
  const candidates = [
    join(root, 'bundle-runtime', 'plugins', 'dsh-undo-savepoint', 'lib', 'base.mjs'),
    join(root, '..', 'plugins', 'dsh-undo-savepoint', 'lib', 'base.mjs'),
  ]
  const base = candidates.find((p) => existsSync(p))
  if (!base) {
    console.log('  ⏭️  跳过（本机没有 dsh-undo-savepoint 的构建产物）')
  } else {
    const target = join(TMP, 'plugin-ws', UNDO_DIR_NAME, 'snapshots')
    mkdirSync(join(target, 'auto'), { recursive: true })
    process.env.DSH_UNDO_ROOT = target
    const mod = await import(`${pathToFileURL(base).href}?t=${Date.now()}`)
    check(mod.LEGACY_ROOT === target, '插件的 LEGACY_ROOT 就等于我们注入的根', mod.LEGACY_ROOT)
    const roots = mod.resolveStoreRoots('web')
    check(roots.manualDir.startsWith(target) && roots.autoDir.startsWith(target),
      'manual/auto 都落在新根下', JSON.stringify(roots))
    check(roots.autoDir.endsWith('auto') && roots.manualDir.endsWith('manual'), '仍是 <根>/{manual,auto} 的双仓布局')
    check(mod.EXPORT_ROOT.startsWith(join(target, '..')), '导出目录也随根走（不会写回 AppData）', mod.EXPORT_ROOT)
    delete process.env.DSH_UNDO_ROOT
  }
}

rmSync(TMP, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ 快照存储根改动全部断言通过' : `\n❌ ${failures} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
