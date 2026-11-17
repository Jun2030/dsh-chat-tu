# 从当前 DSH profile 卸载「吐泡泡」
#
# 用法（在仓库根目录）：
#   pwsh -File scripts/uninstall.ps1
#   pwsh -File scripts/uninstall.ps1 -ProfileName desktop -RemoveData
#   pwsh -File scripts/uninstall.ps1 -DataDir D:\data\tu-bubbles -RemoveData

param(
  [string]$ProfileName = 'desktop',
  [string]$DataDir,
  [switch]$RemoveData,
  [switch]$KeepData
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
$dataDir = if ($DataDir) { [System.IO.Path]::GetFullPath($DataDir) } else { Join-Path $dshHome 'storages\tu-bubbles' }
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  throw "没找到 profile: $profileDir"
}
if ($RemoveData -and $KeepData) {
  throw 'Cannot use -RemoveData and -KeepData together'
}

Write-Host "==> 从 $profileDir 移除 dsh-tu-bubbles"
& dsh plugin --profile $ProfileName remove dsh-tu-bubbles
$removeExitCode = $LASTEXITCODE
if ($removeExitCode -ne 0) {
  throw "dsh plugin remove failed with exit code $removeExitCode; cleanup skipped"
}

# dsh.profile.bundles 里如果还留着条目，一并清掉（用 node 改 JSON，避免手写正则出错）。
$pkgFile = Join-Path $profileDir 'package.json'
node -e @'
const fs = require('node:fs')
const file = process.argv[1]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const bundles = pkg.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const next = bundles.filter((name) => name !== 'dsh-tu-bubbles')
  if (next.length !== bundles.length) {
    pkg.dsh.profile.bundles = next
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
    console.log('已从 dsh.profile.bundles 移除 dsh-tu-bubbles')
  }
}
'@ $pkgFile
if ($LASTEXITCODE -ne 0) {
  throw "profile cleanup failed with exit code $LASTEXITCODE; data cleanup skipped"
}

if ($RemoveData) {
  if (Test-Path $dataDir) {
    Write-Host "==> 删除本地数据库目录 $dataDir"
    Remove-Item -Recurse -Force $dataDir
  }
} else {
  Write-Host "==> 保留本地数据库（使用 -RemoveData 才删除：$dataDir）"
}

Write-Host ''
Write-Host '卸载完成。重启 DeepSeek Harness 后生效。'
