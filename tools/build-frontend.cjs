// build-frontend.cjs — 统一前端打包入口(接入安装器构建链)
//  1. 从 orig_html 恢复原始 HTML 到 public(解决 build_frontend 非幂等)
//  2. 重建 bundles (build_frontend.cjs)
//  3. 改写 HTML 引用 bundle (replace_scripts.cjs)
//  4. (可选)同步到目标 public(win-unpacked resources/app/public)
// 用法: node build-frontend.cjs [publicDir] [targetPublicDir]
//
// ★ 与 build.mjs 一致:不用 fs.rmSync/cpSync 的 recursive 选项(本环境会崩
//   exit -1073740791),全部手动递归实现。
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const TOOLS = __dirname
const ROOT = path.resolve(TOOLS, '..')
const PUBLIC = path.resolve(process.argv[2] || path.join(ROOT, 'packages', 'gui', 'public'))
const ORIG = path.join(ROOT, 'packages', 'gui', 'orig_html')
const TARGET = process.argv[3] ? path.resolve(process.argv[3]) : null
function say(s) { console.log('[build-frontend] ' + s) }
function rmTree(p) {
  if (!fs.existsSync(p)) return
  for (const f of fs.readdirSync(p)) {
    const fp = path.join(p, f)
    if (fs.statSync(fp).isDirectory()) rmTree(fp)
    else { try { fs.unlinkSync(fp) } catch (e) {} }
  }
  try { fs.rmdirSync(p) } catch (e) {}
}
function copyTree(s, d) {
  fs.mkdirSync(d, { recursive: true })
  for (const f of fs.readdirSync(s)) {
    const sp = path.join(s, f), dp = path.join(d, f)
    if (fs.statSync(sp).isDirectory()) copyTree(sp, dp)
    else { try { fs.copyFileSync(sp, dp) } catch (e) { say('copy fail ' + sp + ': ' + e.code) } }
  }
}
if (!fs.existsSync(ORIG)) { console.error('missing orig_html: ' + ORIG); process.exit(1) }
// 1 恢复原始 HTML
for (const f of fs.readdirSync(ORIG).filter(f => f.endsWith('.html'))) {
  fs.copyFileSync(path.join(ORIG, f), path.join(PUBLIC, f))
}
say('restored ' + fs.readdirSync(ORIG).filter(f => f.endsWith('.html')).length + ' html from orig_html')
// 2 清 bundles + 重建
rmTree(path.join(PUBLIC, 'bundles'))
say('run build_frontend')
execFileSync(process.execPath, [path.join(TOOLS, 'build_frontend.cjs'), PUBLIC], { stdio: 'inherit' })
say('run replace_scripts')
execFileSync(process.execPath, [path.join(TOOLS, 'replace_scripts.cjs'), PUBLIC], { stdio: 'inherit' })
// 3 同步目标
if (TARGET) {
  rmTree(path.join(TARGET, 'bundles'))
  fs.mkdirSync(TARGET, { recursive: true })
  copyTree(path.join(PUBLIC, 'bundles'), path.join(TARGET, 'bundles'))
  for (const f of fs.readdirSync(PUBLIC).filter(f => f.endsWith('.html'))) {
    fs.copyFileSync(path.join(PUBLIC, f), path.join(TARGET, f))
  }
  say('synced to ' + TARGET)
}
say('done')
process.exit(0)
