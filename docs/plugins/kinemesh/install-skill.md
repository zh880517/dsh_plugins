# 把 kinemesh Skill 装到第三方 Agent 工具（Claude Code / Codex / 其它）

> **给 AI Agent 的安装指令**：本文件就是安装说明，按「安装步骤」执行即可；不确定装到哪个 Agent
> （Claude Code / Codex / 其它）时，先问用户一句话，再动手。装完按「自检清单」逐项验证并回报。

## 可以直接发给 AI Agent 的链接

**最省事（推荐）**：发插件目录链接，GitHub 会把该目录的 README 渲染在页面上，README 的
「安装 A / 第三方 Agent」段就是可执行步骤：

```
https://github.com/zh880517/dsh_plugins/tree/main/plugins/kinemesh
```

本文件（更完整：自检清单、链接安装、升级卸载、常见问题）：

```
https://github.com/zh880517/dsh_plugins/blob/main/docs/plugins/kinemesh/install-skill.md
```

机器可读原文（部分 Agent 抓不了 HTML 页面时用这两个）：

```
https://raw.githubusercontent.com/zh880517/dsh_plugins/main/plugins/kinemesh/README.md
https://raw.githubusercontent.com/zh880517/dsh_plugins/main/docs/plugins/kinemesh/install-skill.md
```

把上面任一条发给 Agent 并说「按这个装 kinemesh 技能」，它就能照本文件完成安装。
需要钉版本时，把路径里的 `main` 换成 40 位 commit sha（`git log -1` 查）。

> ⚠️ 本说明里的 raw 链接跟随仓库 `main` 分支：只有相关版本**已推送到 GitHub** 时，下载到的才是
> 当前版本。装完务必用 `--version` 核对版本号；若明显偏旧，说明仓库还没推送，改用具体 commit 的
> raw 链接（把 `main` 换成 sha）或让仓库维护者先推送。

## 装完得到什么

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 技能说明与用法（Claude Code / 任意支持 SKILL 的 Agent 读它） |
| `agents/openai.yaml` | Codex 技能元数据（技能列表显示名 / 简介 / `$kinemesh` 预置提示） |
| `cli/kinemesh.cjs` | 单文件 CLI（three.js + 渲染器全内联，约 2.9 MB）：`info` / `analyze` / `skeleton` **零依赖**；`render` 需目标工程装 playwright |
| `mcp/kinemesh-mcp.js`（可选） | stdio MCP server，与 Skill 同一套核心，供只接 MCP 的客户端 |

依赖只有 **Node ≥ 18**。

## 安装步骤（raw 下载，不需要 git）

### 1. 选目标目录

| Agent | 全局技能目录 |
|---|---|
| Claude Code | `~/.claude/skills/kinemesh`（Windows：`%USERPROFILE%\.claude\skills\kinemesh`） |
| Codex | `~/.codex/skills/kinemesh`（Windows：`%USERPROFILE%\.codex\skills\kinemesh`） |
| 其它 | 该 Agent 的技能目录；或任意目录后手动指过去 |

### 2. 下载三个文件

PowerShell（Windows）：

```powershell
$base = 'https://raw.githubusercontent.com/zh880517/dsh_plugins/main/plugins/kinemesh/skill'
$dest = "$env:USERPROFILE\.claude\skills\kinemesh"   # Codex 换成 .codex\skills\kinemesh
New-Item -ItemType Directory -Force "$dest\cli", "$dest\agents" | Out-Null
curl.exe -fL -o "$dest\SKILL.md"            "$base/SKILL.md"
curl.exe -fL -o "$dest\agents\openai.yaml"  "$base/agents/openai.yaml"
curl.exe -fL -o "$dest\cli\kinemesh.cjs"    "$base/cli/kinemesh.cjs"
```

bash / zsh（macOS / Linux / WSL）：

```bash
base=https://raw.githubusercontent.com/zh880517/dsh_plugins/main/plugins/kinemesh/skill
dest="$HOME/.claude/skills/kinemesh"    # Codex 换成 "$HOME/.codex/skills/kinemesh"
mkdir -p "$dest/cli" "$dest/agents"
curl -fL -o "$dest/SKILL.md"           "$base/SKILL.md"
curl -fL -o "$dest/agents/openai.yaml" "$base/agents/openai.yaml"
curl -fL -o "$dest/cli/kinemesh.cjs"   "$base/cli/kinemesh.cjs"
```

> 想同时装 Claude 和 Codex：把上面 `dest` 换成两个目录各跑一遍（或装一份后建链接，见「用链接安装」）。

### 3. 验证 CLI（这一步一定要做）

```powershell
node "$dest\cli\kinemesh.cjs" --version      # 期望输出 kinemesh 0.9.x
node "$dest\cli\kinemesh.cjs" --help         # 期望打印用法（info / analyze / skeleton / render）
```

有模型文件时再跑一次冒烟（不需要 playwright）：

```powershell
node "$dest\cli\kinemesh.cjs" info "C:\path\to\hero.fbx"
# 期望 stdout 一行 JSON：{"ok":true, ... "clips":[...] ...}
```

### 4. 重启 Agent 客户端

Claude Code / Codex 都在**启动时扫描技能目录**，装完要重启一次；之后对话框里用 `$kinemesh`
（Codex）或直接提「分析这个 FBX」即可触发。

### 5.（可选）MCP

只接 MCP 的客户端装这个单文件 server（同样自包含，约 3.6 MB）：

```powershell
$mcp = "$env:USERPROFILE\.kinemesh\mcp"
New-Item -ItemType Directory -Force $mcp | Out-Null
curl.exe -fL -o "$mcp\kinemesh-mcp.js" 'https://raw.githubusercontent.com/zh880517/dsh_plugins/main/plugins/kinemesh/mcp/kinemesh-mcp.js'
```

配置片段（任意 MCP 客户端）：

```json
{ "mcpServers": { "kinemesh": { "command": "node", "args": ["<mcp 目录>/kinemesh-mcp.js"] } } }
```

## 用链接安装（已经 clone 了本仓库的人）

改源码/重建后立刻生效，不用复制：

```powershell
# 装到 Claude + Codex 全局（幂等；已存在会复用或替换为链接）
.\scripts\install-skill.ps1
.\scripts\install-skill.ps1 -Uninstall     # 只删链接，不动源码
```

手动等价（Windows Junction；macOS/Linux 用 `ln -s`）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\kinemesh" `
  -Target "D:\GitHub\dsh_plugins\plugins\kinemesh\skill"
```

## 自检清单（Agent 装完逐项确认并回报用户）

- [ ] 目标目录里三个文件都在：`SKILL.md`、`agents/openai.yaml`、`cli/kinemesh.cjs`
- [ ] `node cli/kinemesh.cjs --version` 输出 `kinemesh 0.9.x`（不是 `dev`、不是空）
- [ ] `node cli/kinemesh.cjs --help` 打印用法（含 `info` / `analyze` / `skeleton` / `render`）
- [ ] 若有模型文件：`info <file>` 返回 `{"ok":true,...}`
- [ ] 告诉用户已装到哪个目录、需要重启客户端
- [ ] 若用户要截图：提示 `render` 需在该工程 `npm i playwright && npx playwright install chromium`

## 升级 / 卸载

- **升级**：重跑「下载三个文件」（覆盖同名文件）→ `--version` 确认新版本号 → 重启客户端；
- **卸载**：删除技能目录（`Remove-Item -Recurse "<dest>"` / `rm -rf "$dest"`），链接安装的只删链接即可。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `--version` / `--help` 无输出、退出码 0 | 装的是 ≤ 0.9.4 且用**链接/junction** 调用的旧版 bug（入口按字面路径判断是否直接执行）→ 升级到 0.9.5+ |
| `render` 报「本机没有 playwright」 | 在**你运行 CLI 的工程**里 `npm i playwright && npx playwright install chromium`（CLI 按 Node 常规模块解析向上找） |
| Codex 技能列表里没名字/没简介 | 缺 `agents/openai.yaml`（本说明第 2 步会下载） |
| 下载 2.9 MB 文件很慢 | 网络原因；也可改用 `git clone --depth 1` + 只取 `plugins/kinemesh/skill/` 目录（稀疏检出） |
| `--version` 输出明显偏旧（如 0.5.x） | 仓库 `main` 还没推到该版本；改用具体 commit 的 raw 链接（把 `main` 换成 sha）或让维护者推送 |
| 产物落到了系统临时目录 | 装的是旧版；0.9.2+ 缺省写到**当前工作目录**的 `.kinemeshtmp/run-<时间戳>-<pid>/`，可用 `KINEMESH_TMP_DIR` 覆盖 |
| 想确认动作分析能力 | 见 [README](./README.md) 与 [design.md](./design.md)：`analyze` 出分段/facts/循环判定，`render` 出关键帧截图供读图 |
