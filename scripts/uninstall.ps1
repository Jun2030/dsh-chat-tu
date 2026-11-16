# 从当前 DSH profile 卸载「吐泡泡」
#
# 用法（在仓库根目录）：
#   pwsh -File scripts/uninstall.ps1
#   pwsh -File scripts/uninstall.ps1 -ProfileName desktop

param(
  [string]$ProfileName = 'desktop',
  [switch]$KeepData
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  throw "没找到 profile: $profileDir"
}

Write-Host "==> 从 $profileDir 移除 dsh-tu-bubbles"
& dsh plugin --profile $ProfileName remove dsh-tu-bubbles
if ($LASTEXITCODE -ne 0) {
  Write-Warning "pnpm remove 返回 $LASTEXITCODE（可能本来就没装），继续清理配置"
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

if (-not $KeepData) {
  $dataDir = Join-Path $dshHome 'storages\tu-bubbles'
  if (Test-Path $dataDir) {
    Write-Host "==> 删除本地数据库目录 $dataDir"
    Remove-Item -Recurse -Force $dataDir
  }
} else {
  Write-Host '==> 保留本地数据库（-KeepData）'
}

Write-Host ''
Write-Host '卸载完成。重启 DeepSeek Harness 后生效。'
