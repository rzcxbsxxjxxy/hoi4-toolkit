# HOI4 Toolkit - 更新成品(重新打包 exe)
# 双击由 更新成品.bat 调用,也可右键"使用 PowerShell 运行"。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

Write-Host '================================================'
Write-Host '  HOI4 Toolkit - 更新成品 重新打包 exe'
Write-Host '  产物目录: app\win-unpacked'
Write-Host '================================================'
Write-Host ''

Write-Host '[1/4] 构建后端 server.mjs / worker-entry.mjs ...'
npm run build:server
if ($LASTEXITCODE -ne 0) { Write-Host ''; Write-Host '[失败] 后端构建失败 esbuild,未覆盖旧成品。'; Read-Host '按回车退出'; exit 1 }
Write-Host '      后端构建 OK'

Write-Host '[2/4] 暂存前端资源 packages\gui\public -^> 根目录 public ...'
node stage.mjs
if ($LASTEXITCODE -ne 0) { Write-Host ''; Write-Host '[失败] 前端暂存失败,未覆盖旧成品。'; Read-Host '按回车退出'; exit 1 }
Write-Host '      前端暂存 OK'

Write-Host '[3/4] electron-builder 打包 输出 app\win-unpacked ...'
npx electron-builder --dir --config.directories.output=app
if ($LASTEXITCODE -ne 0) { Write-Host ''; Write-Host '[失败] electron-builder 打包失败,未覆盖旧成品。'; Read-Host '按回车退出'; exit 1 }
Write-Host '      打包 OK'

Write-Host '[3.5/4] 注入 app-update.yml(更新源=GitHub Releases) ...'
node tools/write-update-config.cjs "app\win-unpacked\resources"
if ($LASTEXITCODE -ne 0) { Write-Host ''; Write-Host '[失败] 注入 app-update.yml 失败。'; Read-Host '按回车退出'; exit 1 }
Write-Host '      app-update.yml OK'

Write-Host '[4/4] 清理暂存 删除根目录 public ...'
node clean.mjs

Write-Host ''
Write-Host '自检打包产物是否包含最新前端标记 ...'
$mark = '__mio_header__'
$prod = Join-Path $PSScriptRoot 'app\win-unpacked\resources\app\public\dlc.js'
if (Test-Path -LiteralPath $prod) {
  $c = [IO.File]::ReadAllText($prod)
  if ($c.Contains($mark)) { Write-Host '自检通过 产物已包含最新前端改动。' }
  else { Write-Host '[警告] 产物 public\dlc.js 未含最新前端改动,请检查源码与打包流程!' }
} else {
  Write-Host '[警告] 产物 public\dlc.js 不存在!'
}

Write-Host ''
Write-Host '================================================'
Write-Host '  完成 成品在 app\win-unpacked'
Write-Host '  双击 启动打包版.bat 运行。'
Write-Host '================================================'
Read-Host '按回车退出'
exit 0