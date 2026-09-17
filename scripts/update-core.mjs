/**
 * 构建前把内核升到 npm 上的最新版本。
 *
 * 内核（@deepseek-ai/dsh 及 dsh-web-app）没有运行期更新轨道，它随安装包
 * 一起发布——所以「更新内核」就发生在构建之前：
 *
 *     pnpm update-core
 *
 * 做三件事：
 *   1. 查 npm 官方源上 @deepseek-ai/dsh 的最新版本（含预发布，本发行版
 *      自己就在 0.1.2-rc 线，不能只看正式版）；
 *   2. 把 package.json 里两个内核依赖钉到该精确版本；
 *   3. pnpm install 让锁步的 200+ 个 @deepseek-ai/* 包整组落到新版本。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')

const latest = execSync('npm view @deepseek-ai/dsh version', { encoding: 'utf8' }).trim()
if (!latest) throw new Error('npm view 没有返回版本号。')

const pkgPath = join(rootDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const from = pkg.dependencies['@deepseek-ai/dsh']
pkg.dependencies['@deepseek-ai/dsh'] = latest
pkg.dependencies['@deepseek-ai/dsh-web-app'] = latest
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

console.log(`[update-core] 内核依赖：${from} → ${latest}，开始 pnpm install 同步锁步包…`)
execSync('pnpm install', { cwd: rootDir, stdio: 'inherit' })
const installed = JSON.parse(readFileSync(join(rootDir, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
console.log(`[update-core] 完成：node_modules 里的内核现在是 ${installed}。`)
if (installed !== latest) {
  throw new Error(`期望 ${latest}，实际装上的是 ${installed}，请检查 pnpm 覆盖配置。`)
}
