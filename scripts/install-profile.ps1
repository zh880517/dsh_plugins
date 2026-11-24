# install-profile.ps1 — 把本仓库的插件安装到 DSH profile（正确姿势）
# 用法：
#   .\scripts\install-profile.ps1 -Plugin kinemesh          # 安装/更新指定插件
#   .\scripts\install-profile.ps1 -All                      # 安装全部插件
#   .\scripts\install-profile.ps1 -Plugin kinemesh -Uninstall  # 卸载指定插件
#
# 原理：不走 npm/pnpm（那会拆掉 DSH 宿主自己管理的 node_modules），而是把插件以 link: 方式
# 挂进 profile 的 package.json + 重建 bundles 列表，再调 DSH 的 plugin_manager 完成安装。
# 对于本机开发（link: 本地目录），直接编辑 package.json 就够了——plugin_manager 的
# install_bundle 内部也是做同样的事，但它走 pnpm 会清掉 DSH 管的核心包。
# 所以本脚本的核心思路是：**只追加/删除本仓库管理的插件条目，不碰其他依赖**。

param(
    [Parameter(Mandatory = $false)]
    [string]$Plugin,

    [Parameter(Mandatory = $false)]
    [switch]$All,

    [Parameter(Mandatory = $false)]
    [switch]$Uninstall,

    [Parameter(Mandatory = $false)]
    [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"

if (-not (Test-Path $profileDir)) {
    Write-Error "Profile 目录不存在：$profileDir"
    exit 1
}

$pkgFile = Join-Path $profileDir 'package.json'

# 发现本仓库全部插件
$allPlugins = Get-ChildItem (Join-Path $repoRoot 'plugins') -Directory | ForEach-Object { $_.Name }

if ($All) {
    $targets = $allPlugins
} elseif ($Plugin) {
    if ($allPlugins -notcontains $Plugin) {
        Write-Error "插件 '$Plugin' 不存在于 $($repoRoot)\plugins\（可用：$($allPlugins -join ', ')）"
        exit 1
    }
    $targets = @($Plugin)
} else {
    Write-Host "可用插件：$($allPlugins -join ', ')"
    Write-Host "用法：.\scripts\install-profile.ps1 -Plugin <id>  或  -All  或  -Plugin <id> -Uninstall"
    exit 0
}

# 读写 profile package.json（只动本仓库管理的插件条目）
$pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json

foreach ($id in $targets) {
    $pluginDir = Join-Path $repoRoot "plugins\$id"
    $pkgJson = Get-Content (Join-Path $pluginDir 'package.json') -Raw | ConvertFrom-Json
    $pkgName = $pkgJson.name

    if ($Uninstall) {
        # 从 dependencies 删除
        if ($pkg.dependencies.PSObject.Properties[$pkgName]) {
            $pkg.dependencies.PSObject.Properties.Remove($pkgName)
            Write-Host "[卸载] $pkgName（dependencies 移除）" -ForegroundColor Yellow
        }
        # 从 bundles 删除
        $bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $pkgName })
        # 更新 JSON（需要重建对象）
        $pkg | Add-Member -Force -MemberType NoteProperty -Name 'dsh' -Value @{
            profile = @{ bundles = $bundles }
        }
        Write-Host "[卸载] $pkgName（bundles 移除）" -ForegroundColor Yellow
    } else {
        # 确保在 dependencies 里以 link: 指向本地目录
        if (-not $pkg.dependencies) {
            $pkg | Add-Member -MemberType NoteProperty -Name 'dependencies' -Value @{}
        }
        $pkg.dependencies | Add-Member -Force -MemberType NoteProperty -Name $pkgName -Value "link:$pluginDir"
        Write-Host "[安装] $pkgName → link:$pluginDir" -ForegroundColor Green

        # 确保在 bundles 里
        if (-not $pkg.dsh.profile.bundles -contains $pkgName) {
            $bundles = @($pkg.dsh.profile.bundles) + $pkgName
            $pkg | Add-Member -Force -MemberType NoteProperty -Name 'dsh' -Value @{
                profile = @{ bundles = $bundles }
            }
            Write-Host "[安装] $pkgName → bundles 追加" -ForegroundColor Green
        }
    }
}

# 写回 package.json（只改我们管的字段，其他字段保持不动）
$pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgFile -Encoding UTF8

# 手动创建/更新 node_modules 里的符号链接（不走 npm/pnpm）
$nmDir = Join-Path $profileDir 'node_modules'
if (-not (Test-Path $nmDir)) { New-Item $nmDir -ItemType Directory -Force | Out-Null }

foreach ($id in $targets) {
    $pluginDir = Join-Path $repoRoot "plugins\$id"
    $pkgJson = Get-Content (Join-Path $pluginDir 'package.json') -Raw | ConvertFrom-Json
    $pkgName = $pkgJson.name
    $scope = $pkgName.Split('/')[0]
    $scopeDir = Join-Path $nmDir $scope
    $linkPath = Join-Path $nmDir $pkgName

    if ($Uninstall) {
        if (Test-Path $linkPath) {
            # 删除符号链接或 junction（不动真实内容）
            $item = Get-Item $linkPath -Force
            if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
                $item.Delete()
                Write-Host "[卸载] $linkPath（链接删除）" -ForegroundColor Yellow
            } else {
                Remove-Item $linkPath -Recurse -Force
                Write-Host "[卸载] $linkPath（目录删除）" -ForegroundColor Yellow
            }
        }
    } else {
        if (Test-Path $scopeDir -PathType Container) {
            # scope 目录已存在
        } else {
            New-Item $scopeDir -ItemType Directory -Force | Out-Null
        }
        if (Test-Path $linkPath) {
            # 已存在（旧链接或目录），先删再建
            $item = Get-Item $linkPath -Force
            if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
                $item.Delete()
            } else {
                Remove-Item $linkPath -Recurse -Force
            }
        }
        # 创建 junction（Windows 上不需要管理员权限）
        New-Item -Path $linkPath -ItemType Junction -Value $pluginDir -Force | Out-Null
        Write-Host "[安装] $linkPath → junction → $pluginDir" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "完成。重启 DSH 后生效（或在 Plugins 页面刷新）。" -ForegroundColor Cyan
if ($Uninstall) {
    Write-Host "已卸载：$($targets -join ', ')"
} else {
    Write-Host "已安装：$($targets -join ', ')"
    Write-Host "新会话里让 Agent 调一次 kinemesh_info 等工具即可触发预览页签。"
}
