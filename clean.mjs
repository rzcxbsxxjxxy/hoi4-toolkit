// 打包收尾清理脚本(build 后置)
//
// 项目已提升为根目录:只删 stage.mjs 拷进根目录的 ./public 暂存目录。
// 源码树的 packages/gui/public 与根目录只读资源(VERSION/example/README 等)均不动。
//
// ★ 跨平台铁律(Windows cmd.exe 没有 rm):用 Node 内置 fs 手动递归删除,
//   不用 shell `rm -rf`,也不用 fs.rmSync 的 recursive。

import { existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const p = join(__dirname, 'public')

// 手动递归删除目录
function rmDir(target) {
  for (const name of readdirSync(target)) {
    const fp = join(target, name)
    if (statSync(fp).isDirectory()) rmDir(fp)
    else unlinkSync(fp)
  }
  rmdirSync(target)
}

if (existsSync(p)) {
  console.log(`[clean] 删除暂存 "${p}"`)
  rmDir(p)
}
console.log('[clean] 完成')