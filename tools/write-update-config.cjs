// write-update-config.cjs — 把更新源配置写进打包产物的 resources/app-update.yml。
//
// 背景:electron-builder 的 `--dir`(免安装 / portable 的前置打包)不会生成
// app-update.yml,导致已安装程序缺更新源、主进程 configuredUpdateUrl() 返回空、
// setupUpdater() 不再调用 checkForUpdates()——启动后台检测与设置页「软件更新」全部失效。
// electron-updater 启动即读 process.resourcesPath/app-update.yml,凭 provider/owner/repo 判定 GitHub 更新源。
//
// 用法:node write-update-config.cjs <resources目录> [owner] [repo]
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
const resourcesDir = args[0] || join(__dirname, '..', 'app', 'win-unpacked', 'resources')
const owner = args[1] || 'rzcxbsxxjxxy'
const repo = args[2] || 'hoi4-toolkit'

mkdirSync(resourcesDir, { recursive: true })
const yml = [
  'owner: ' + owner,
  'repo: ' + repo,
  'provider: github',
  '',
].join('\n')
writeFileSync(join(resourcesDir, 'app-update.yml'), yml, 'utf8')
console.log('[write-update-config] wrote ' + join(resourcesDir, 'app-update.yml') +
  ' (provider=github, ' + owner + '/' + repo + ')')
