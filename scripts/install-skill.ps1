# 把 kinemesh Skill 以链接（junction）方式装到 Claude / Codex 的全局技能目录。
# 用法：
#   .\scripts\install-skill.ps1                 # 装到 ~/.claude/skills/kinemesh 与 ~/.codex/skills/kinemesh
#   .\scripts\install-skill.ps1 -Uninstall      # 只删这两个链接（不动源目录）
#   .\scripts\install-skill.ps1 -Plugin kinemesh
# 为什么用 junction：源码在本仓库，链接后改 SKILL.md / 重新 npm run build 立刻生效，不用复制。
# 删除用 Remove-Item（不会跟随链接删源文件）。
param(
  [string]$Plugin = 'kinemesh',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "plugins\$Plugin\skill"
$homeDir = $env:USERPROFILE

if (-not (Test-Path $source)) {
  Write-Error "找不到技能源目录：$source"
}

if (-not (Test-Path (Join-Path $source 'SKILL.md'))) {
  Write-Error "技能目录缺 SKILL.md：$source"
}
if (-not (Test-Path (Join-Path $source "cli\$Plugin.cjs"))) {
  Write-Error "技能目录缺 CLI 产物：$source\cli\$Plugin.cjs（先跑 npm run build -- --only $Plugin）"
}

$links = @(
  @{ Agent = 'Claude'; Path = (Join-Path $homeDir ".claude\skills\$Plugin") },
  @{ Agent = 'Codex'; Path = (Join-Path $homeDir ".codex\skills\$Plugin") }
)

foreach ($link in $links) {
  $parent = Split-Path -Parent $link.Path
  if ($Uninstall) {
    if (Test-Path $link.Path) {
      Remove-Item $link.Path -Recurse -Force
      Write-Host "已删除 $($link.Agent) 链接：$($link.Path)"
    } else {
      Write-Host "$($link.Agent) 没有该链接（跳过）：$($link.Path)"
    }
    continue
  }

  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
  }
  if (Test-Path $link.Path) {
    $existing = Get-Item $link.Path
    if ($existing.LinkType -ne 'Junction' -and $existing.LinkType -ne 'SymbolicLink') {
      Write-Warning "$($link.Path) 已存在且不是链接（可能是手工复制的旧版本）。先删掉它再重跑本脚本。"
      continue
    }
    if ($existing.Target -eq $source) {
      Write-Host "$($link.Agent) 链接已就绪：$($link.Path) -> $source"
      continue
    }
    Remove-Item $link.Path -Recurse -Force
  }
  New-Item -ItemType Junction -Path $link.Path -Target $source | Out-Null
  Write-Host "已创建 $($link.Agent) 链接：$($link.Path) -> $source"
}

# 装完顺手校验：过链接跑一次 --version（链接场景曾因 argv realpath 不一致而静默不执行）
if (-not $Uninstall) {
  $cli = Join-Path $links[0].Path "cli\$Plugin.cjs"
  if (Test-Path $cli) {
    $version = & node $cli --version 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Host "校验通过：$version"
    } else {
      Write-Warning "校验失败（--version 退出码 $LASTEXITCODE）：$version"
    }
  }
}
