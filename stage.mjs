// 打包暂存脚本(build 前置)
//
// 项目已提升为根目录:electron 壳(main.cjs 等)与前端源码(packages/gui/public)
// 都在 toolkit 根下。electron-builder 的 files 不支持 "../" 跨目录 glob,故打包前
// 把前端 public 拷到根目录 ./public,使 files 只列相对项(目录名整体拷贝);打完包
// 由 clean.mjs 删掉 ./public(源码树的真实前端仍在 packages/gui/public,不受影响)。
//
// ★ 跨平台铁律(Windows cmd.exe 没有 rm/cp,shell 方案会失败):
//   拷贝/删除一律用 Node 内置 fs 的**手动递归**(readdirSync/copyFileSync/
//   unlinkSync/rmdirSync),不用 shell `rm -rf`/`cp -r`,也不用 fs.cpSync/rmSync
//   的 recursive —— 后者在受限环境会被拦截。

import {
  existsSync, readdirSync, mkdirSync, copyFileSync,
  statSync, unlinkSync, rmdirSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_SRC = join(__dirname, 'packages', 'gui', 'public')
const PUBLIC_DST = join(__dirname, 'public')

// 手动递归删除目录(跨平台;只用 readdir/unlink/rmdir)
function rmDir(target) {
  for (const name of readdirSync(target)) {
    const p = join(target, name)
    if (statSync(p).isDirectory()) rmDir(p)
    else unlinkSync(p)
  }
  rmdirSync(target)
}

// 手动递归拷贝目录(跨平台;只用 readdir/mkdir/copyFile)
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dst, name)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

// 前端静态资源(必须):递归拷贝整个 public 到根目录 ./public 暂存
// 若已存在先删(可能是上次失败残留)
if (existsSync(PUBLIC_DST)) {
  console.log(`[stage] 清理旧暂存 "${PUBLIC_DST}"`)
  rmDir(PUBLIC_DST)
}
console.log(`[stage] 拷贝 public -> "${PUBLIC_DST}"`)
copyDir(PUBLIC_SRC, PUBLIC_DST)

// 根目录只读资源(VERSION / 示例配置 / 文档)本就在根目录,files 直接列名即可,
// 无需拷贝。这里仅确认存在,缺失则报错以便及时发现。
for (const f of ['VERSION', 'version.json', 'gui-settings.example.json', 'README.md', '新手指南.md']) {
  if (!existsSync(join(__dirname, f))) {
    throw new Error(`[stage] 缺少根目录只读资源: ${f}`)
  }
}

console.log('[stage] 暂存完成')