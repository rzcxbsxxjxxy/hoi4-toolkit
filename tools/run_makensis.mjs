// ============================================================================
//  run_makensis.mjs — 单独编译一个 .nsi(开发期校验用),绕开 electron-builder
//
//  ★ 为什么不用 `-I<含空格的路径>`:
//    实测 makensis 会把 `-IC:\...\Contrib\Modern UI 2` 按空格切成两个参数,
//    于是只打印 Usage 不编译(退出码 1,但没有任何报错信息,极易误判成"脚本写错")。
//    electron-builder 自己也不传 -I,它把 include 目录写进脚本的 !addincludedir。
//    所以本脚本同样:设 NSISDIR 环境变量 + 让脚本内自己 !addincludedir。
//
//  ★ 为什么脚本走 stdin:
//    electron-builder 是 `args.push("-")` 然后把脚本喂给 stdin
//    (见 app-builder-lib/out/targets/nsis/NsisTarget.js)。
//    走 stdin 还有个好处:路径里有中文/空格不会被命令行解析搅乱。
//
//  用法: node tools/run_makensis.mjs <脚本.nsi>
//        node tools/run_makensis.mjs <脚本.nsi> --out "输出.exe"
// ============================================================================

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NSIS = join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache/nsis/nsis-3.0.4.1')
const MAKEN = join(NSIS, 'Bin', 'makensis.exe')

if (!existsSync(MAKEN)) {
  console.error(`✗ 找不到 ${MAKEN}\n  先跑一次 electron-builder 让它把 NSIS 缓存下载下来。`)
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const argv = process.argv.slice(2)
const scriptArg = argv[0]
if (!scriptArg) {
  console.error('用法: node tools/run_makensis.mjs <脚本.nsi>')
  process.exit(1)
}
const scriptPath = resolve(ROOT, scriptArg)
if (!existsSync(scriptPath)) {
  console.error(`✗ 找不到脚本 ${scriptPath}`)
  process.exit(1)
}

// OutFile 由脚本自身的 OutFile 决定;这里只把脚本喂进去
const r = spawnSync(MAKEN, ['-INPUTCHARSET', 'UTF8', '-'], {
  input: readFileSync(scriptPath),
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: false,
  env: { ...process.env, NSISDIR: NSIS },
  cwd: dirname(scriptPath),
})
process.exit(r.status ?? 1)