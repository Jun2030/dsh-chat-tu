# 安装「吐泡泡」到当前 DSH profile
#
# 推荐路径：在 DSH 里用「插件管理 → 从本地目录安装」指向本仓库目录。
# 本脚本是命令行等价物：把本目录以 link: 方式加入 profile，再让你在界面上启用。
#
# 用法（在仓库根目录）：
#   pwsh -File scripts/install.ps1
#   pwsh -File scripts/install.ps1 -ProfileName desktop -SourceDir .

param(
  [string]$ProfileName = 'desktop',
  [string]$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $SourceDir 'package.json'))) {
  throw "在 $SourceDir 没找到 package.json，请确认 -SourceDir 指向仓库根目录"
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  throw "没找到 profile: $profileDir（先启动一次 DSH Desktop，或确认 profile 名）"
}

Write-Host "==> 目标 profile：$profileDir"
Write-Host "==> 插件目录：  $SourceDir"

if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  Write-Warning 'DeepSeek Harness 正在运行。修改 profile 依赖建议先退出 Desktop，装完再启动。'
}

Write-Host '==> 通过 dsh CLI 把本地目录装进 profile（底层是 pnpm add）...'
& dsh plugin --profile $ProfileName add $SourceDir
if ($LASTEXITCODE -ne 0) {
  throw "dsh plugin add 失败（退出码 $LASTEXITCODE）"
}

Write-Host ''
Write-Host '安装完成。剩下一步（手动）：'
Write-Host '  1. 启动 DeepSeek Harness'
Write-Host '  2. 打开「插件管理」，找到「吐泡泡 / Tu Bubbles」，确认已启用（必要时点启用并刷新页面）'
Write-Host '  3. 左侧栏出现气泡图标，点击进入'
Write-Host ''
Write-Host '如果插件管理里看不到，检查 profile 的 package.json 是否含 dsh-tu-bubbles 依赖。'
