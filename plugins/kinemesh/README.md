# 动析 kinemesh（DSH 插件 / 第三方 Agent Skill）

面向游戏 3D 模型/动画资源的 AI 预览与分析：kine（运动/动画）+ mesh（模型）。
本仓库目录既是 **DSH 插件包**，也是**给第三方 Agent 的 Skill + CLI + MCP**（同一套核心）。

## 安装

### A. 第三方 Agent 工具（Claude Code / Codex / 其它）——把本页链接发给你的 AI Agent 即可

> **给 AI Agent**：按本节步骤把技能装到目标客户端；不确定装哪个客户端时先问用户。
> 完整版（含逐项自检清单、Windows/macOS 差异、常见问题）见
> [docs/plugins/kinemesh/install-skill.md](../../docs/plugins/kinemesh/install-skill.md)。

`plugins/kinemesh/skill/` 是**自包含技能目录**（three.js 与渲染器全内联）：

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 技能说明（Claude / 支持 SKILL 的 Agent 读它） |
| `agents/openai.yaml` | Codex 技能元数据（列表显示名 / 简介 / `$kinemesh` 预置提示） |
| `cli/kinemesh.cjs` | 单文件 CLI（约 2.9 MB）：`info` / `analyze` / `skeleton` 零依赖；`render` 需目标工程装 playwright |

目标目录：Claude Code → `~/.claude/skills/kinemesh`；Codex → `~/.codex/skills/kinemesh`；
其它 Agent → 其技能目录。依赖只有 Node ≥ 18。

```bash
# bash / zsh（macOS / Linux / WSL）
BASE=https://raw.githubusercontent.com/zh880517/dsh_plugins/main/plugins/kinemesh/skill
DEST="$HOME/.claude/skills/kinemesh"      # Codex 换成 "$HOME/.codex/skills/kinemesh"
mkdir -p "$DEST/cli" "$DEST/agents"
curl -fL -o "$DEST/SKILL.md"           "$BASE/SKILL.md"
curl -fL -o "$DEST/agents/openai.yaml" "$BASE/agents/openai.yaml"
curl -fL -o "$DEST/cli/kinemesh.cjs"   "$BASE/cli/kinemesh.cjs"
```

```powershell
# PowerShell（Windows）
$base = 'https://raw.githubusercontent.com/zh880517/dsh_plugins/main/plugins/kinemesh/skill'
$dest = "$env:USERPROFILE\.claude\skills\kinemesh"   # Codex 换成 .codex\skills\kinemesh
New-Item -ItemType Directory -Force "$dest\cli", "$dest\agents" | Out-Null
curl.exe -fL -o "$dest\SKILL.md"           "$base/SKILL.md"
curl.exe -fL -o "$dest\agents\openai.yaml" "$base/agents\openai.yaml"
curl.exe -fL -o "$dest\cli\kinemesh.cjs"   "$base/cli/kinemesh.cjs"
```

**校验（必做）**，然后重启客户端（Claude/Codex 启动时扫技能目录）：

```bash
node "$DEST/cli/kinemesh.cjs" --version   # 期望 kinemesh 0.10.x
node "$DEST/cli/kinemesh.cjs" --help      # 期望打印 info/analyze/skeleton/render
node "$DEST/cli/kinemesh.cjs" info <模型文件>   # 有模型时冒烟，期望 {"ok":true,...}
```

可选 MCP（只接 MCP 的客户端）：下载
`https://raw.githubusercontent.com/zh880517/dsh_plugins/main/plugins/kinemesh/mcp/kinemesh-mcp.js`
（单文件，自包含），配置 `{"mcpServers":{"kinemesh":{"command":"node","args":["<mcp 目录>/kinemesh-mcp.js"]}}}`。

- **升级**：重跑上面的下载（覆盖同名文件）→ `--version` 核对 → 重启客户端；
- **卸载**：删除该技能目录即可；
- ⚠️ raw 链接跟随 `main`：装完必须 `--version` 核对版本；仓库尚未推送该版本时，把 URL 里的 `main`
  换成具体 commit sha；
- 离线分发：本仓库 `npm run pack:skill` 会生成 `dist/kinemesh-<版本>.zip`（SKILL + CLI + MCP + 元数据），
  解压后同样可用。

### B. DSH 插件

在 DSH 侧栏 **Plugins → Add plugin** 里粘一条 spec（也可以让 Agent 调 `plugin_manager` 的 `install_bundle`）：

```
git+https://github.com/zh880517/dsh_plugins.git#main&path:/plugins/kinemesh
```

构建产物已随仓库提交，安装时不在本机构建；重开 DSH 生效。

## 功能

- **`kinemesh_info`**（Agent 工具）：读取 FBX / glTF / GLB / OBJ，返回动画片段清单（名称/时长/
  通道数/根运动）、骨骼统计（数量/深度/人形识别）、网格统计（三角面/顶点/蒙皮比例/材质数）、
  贴图清单、包围盒与单位体检（厘米未换算这类坑会标出来）。
- **`kinemesh_analyze`**（Agent 工具，M6）：动作分析——中间文件集（summary / 分段 / 关键帧 / 轨迹 /
  关节曲线）+ summaryDigest 事实句 + 循环/归位判定；AI 只读数据做语义推测，不计算数值。
- **`kinemesh_skeleton`**（Agent 工具，M7）：骨架识别与映射——skeleton-report + 骨骼名标注截图，
  结论写 `kinemesh-bones.json` 后被确定性消费。
- **`kinemesh_render`**（Agent 工具）：按视角（球坐标 view 或 front/side/back/three-quarter/orbit8
  预设）+ 帧号渲染 PNG，返回绝对路径数组；渲染模式 default / solid / wireframe / skeleton /
  bones-overlay，**省略 mode 时按模型自动选**（无 mesh→骨架；贴图解不出来→素模；有可用贴图→default）；
  只给视角预设时**逐帧按身体包围盒自动取景**（带位移的动作不会跑出画面）。需要本机
  playwright + chromium（`npm i playwright && npx playwright install chromium`）。
- **独立 mesh 文件绑定（0.10.0；0.10.1 内容匹配）**：动作文件不带 mesh 时（游戏里动作单独导出的常见情况），
  `kinemesh_render` / `kinemesh_info` 加 `mesh` 参数（CLI `--mesh`）用独立网格文件做渲染主体，
  动画**按骨骼名自动绑定**（部分骨骼的附加动画也支持，未命中骨骼保持 rest）；不传时按**文件内容**
  （有网格 + 骨骼名覆盖率）自动识别同资产网格文件，**不依赖 `_skin` 之类的命名**；跨导出 up-axis /
  根朝向差异会做根骨骼静止姿态差校正（避免角色躺倒）。预览面板同样自动识别并显示「mesh 文件名 · 命中骨骼数」。
- **独立预览页左侧层级列表（0.10.1）**：只记录**当前进程启动后打开过**的模型（内存、可删除）——带 mesh+动画
  的文件是独立条目，动作-only 文件挂在它关联的网格下（网格为根、动作作子节点，`└` 缩进 + 徽标）；
  点一行即按「网格 + 动作」重新加载，× 删除记录（删网格会连同其关联动作）。
- **预览面板（0.6.0 起三入口）**：左侧侧边栏「动析」打开**独立预览页**（拖转视角、播放条
  首帧/逐帧/播放暂停/末帧、轨道条拖帧 + 强度曲线、播放速度 0.1×～2×、显示方式=素模/贴图/线框
  + 独立「叠加骨架」、载入后自动选显示模式、「锁定位移 / 锁定旋转」去掉 root motion、角色根节点
  XYZ 参考轴、左下角全局轴指示器）；会话内另有 `/kinemesh` 命令（拖入 FBX + 要求直接启动分析）
  与「模型预览」页签（会话模型列表 + 发送给 AI 分析）。
- **Skill + CLI**（[skill/](./skill/)）与 **MCP Server**（[mcp/](./mcp/)）：见上面「安装 A」，
  三出口同名同参。

- 支持格式：FBX（ASCII ≥7.0 / 二进制 ≥6400）、glTF / GLB（含 VRM）、OBJ
- 暂不支持：`.max` 等私有格式（给出离线转换指引）；`.blend` 等长尾格式的 assimpjs 兜底暂缓
- 本地只读分析：只读模型文件本身，不联网、不写模型所在目录（截图与分析中间文件缺省写到
  当前工作目录下的 `.kinemeshtmp/run-<时间戳>-<pid>/`，`KINEMESH_TMP_DIR` 可覆盖）

Agent 用法（DSH 工具 / 第三方 CLI 任选）：

```
kinemesh_info({ "path": "D:/assets/characters/hero.fbx" })
kinemesh_render({ "path": "D:/assets/characters/hero.fbx", "clip": "Run", "frames": [0, 15, 30], "viewPreset": "front" })
kinemesh_render({ "path": "D:/assets/characters/hero/hit.fbx", "mesh": "D:/assets/characters/hero/basic/hero_skin.fbx", "clip": "Take 001", "frames": [0, 2] })
```

```bash
node cli/kinemesh.cjs info D:/assets/characters/hero.fbx   # 第三方 Agent 用 CLI 的等价写法
node cli/kinemesh.cjs render D:/assets/characters/hero/hit.fbx --mesh D:/assets/characters/hero/basic/hero_skin.fbx --frames 0,2
```

[完整文档](../../docs/plugins/kinemesh/README.md) ·
[第三方 Agent 安装全文](../../docs/plugins/kinemesh/install-skill.md)
