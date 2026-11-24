# 动析 kinemesh

**面向游戏 3D 模型/动画资源的 AI 预览与分析**。Agent 拿到模型文件后，回答「这个资源有哪些动作、多长、
能不能用」，并按指定视角渲染截图供视觉分析。

中文展示名「动析」：kine（运动/动画）+ mesh（模型）。

## 功能（当前版本）

- **`kinemesh_info`**（Agent 工具）：读取模型文件，返回动画片段清单（名称/时长/通道数/根运动）、
  骨骼统计（数量/最大深度/是否人形）、网格统计（三角面/顶点/蒙皮比例/材质数）、贴图清单、
  包围盒与单位体检（厘米未换算这类坑会标出来）。
- 支持格式：**FBX**（ASCII ≥7.0 / 二进制 ≥6400）、**glTF / GLB**（含 VRM 按 GLB 处理）、**OBJ**。
- **`kinemesh_analyze`**（Agent 工具，M6）：动作分析——产出中间文件集（summary / 分段 / 关键帧 /
  轨迹 SVG / 关节曲线）与 summaryDigest 事实句，含循环/归位检测（`loopMode`）；关键参数：
  `clip`（缺省第一个，`"*"` 批量）、`range` 切片、`sampleFps`、`detail`（summary/standard/full）、
  `vocab` 词汇表、`boneMap` 骨架映射；AI 只读数据做语义推测，不计算数值。
- **`kinemesh_skeleton`**（Agent 工具，M7）：骨架识别与映射——skeleton-report（约定识别 / 覆盖统计 /
  结构统计）+ 骨骼名标注截图交 AI 读图定案，结论写 `kinemesh-bones.json` 确定性消费；关键参数：
  `shots`（auto 缺省有缺口才出图 / none / all）、`boneMap`（参数 > 资产同目录 > cwd 发现）、`out`。
- **`kinemesh_render`**（Agent 工具）：按视角（`view` 球坐标或 `viewPreset` front/side/back/
  three-quarter/orbit8）+ 帧号渲染 PNG。渲染模式 default / solid / wireframe / skeleton /
  bones-overlay，**省略 `mode` 时按模型自动选**（无 mesh→skeleton；贴图解不出来→solid；有可用贴图→
  default）；只给视角预设时**逐帧按身体包围盒精确取景**，带 root motion 的动作不会跑出画面，
  显式给 view 则按指定构图。需要本机 playwright + chromium。
- **预览面板（0.6.0 起三入口）**：左侧侧边栏「动析」独立预览页 / `/kinemesh` 命令 / 会话「模型预览」
  页签。预览能力：拖转视角、播放条（首帧·逐帧·播放暂停·末帧）与播放速度 0.1×～2×、轨道条拖帧 + 强度
  曲线 + 三档刻度、显示方式（素模 / 贴图 / 线框互斥 + 独立「叠加骨架」）、载入后自动选显示模式、
  **「锁定位移 / 锁定旋转」去掉 root motion 原地播放**、角色根节点 XYZ 参考轴（可开关）、左下角全局轴
  指示器、发送给 AI 分析（附动作分析 digest）。
- 本地只读分析：只读模型文件本身，不联网、不写模型所在目录。

当前版本 0.9.2：M1–M7 的四个工具 `kinemesh_info` / `kinemesh_render` / `kinemesh_analyze` /
`kinemesh_skeleton` 三出口同名同参；0.6.0–0.9.2 迭加了预览交互（播放条/轨道/速度、显示方式拆分、
自动选模式、root motion 开关、轴参考）与截图取景（自动模式、逐帧取景），以及产物临时目录收口到
`<cwd>/.kinemeshtmp/`；状态见 [design.md](./design.md) §5 与 §6.10。

## 安装到 Claude / Codex 全局（软链接方式，推荐开发用）

Skill 目录是**唯一事实源**（`plugins/kinemesh/skill/`），用 junction 挂到各 Agent 的全局技能目录即可，
改 `SKILL.md` 或重新 `npm run build` 后**立刻生效、不用复制**：

```powershell
# 一次装到 ~/.claude/skills/kinemesh 与 ~/.codex/skills/kinemesh（已存在则复用/替换为链接）
.\scripts\install-skill.ps1
# 只删链接、不动源码
.\scripts\install-skill.ps1 -Uninstall
```

手动等价命令：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\kinemesh" -Target "D:\GitHub\dsh_plugins\plugins\kinemesh\skill"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.codex\skills\kinemesh" -Target "D:\GitHub\dsh_plugins\plugins\kinemesh\skill"
```

- Claude 读 `SKILL.md`（frontmatter name/description）；
- Codex 额外读 `agents/openai.yaml`（技能列表里的显示名/简介/预置 prompt，`$kinemesh` 调用）；
- 两个 Agent 都通过链接跑同一份 `cli/kinemesh.cjs`：装完用 `node ~/.claude/skills/kinemesh/cli/kinemesh.cjs --version` 核对；
- 链接调用依赖「argv 与真实路径都做 realpath 比较」（0.9.5 修复：此前经 junction 调用会静默不执行）；
- 分发给别人（不在本机开发时）用下面的 zip；解压后同样可以挂链接或直接复制目录。
- **让别人/别人的 AI 自己装**：给对方这一条说明即可 —— [install-skill.md](./install-skill.md)（含 raw 下载命令与自检清单）。

## 分发给第三方 Agent（Skill / CLI / MCP）

DSH 之外的 Agent 工具只用 **Skill + MCP** 两种形式（CLI 作为 Skill 的执行器随附）：

| 产物 | 位置 | 说明 |
|---|---|---|
| Skill 目录 | `plugins/kinemesh/skill/` | `SKILL.md` + `agents/openai.yaml`（Codex 元数据）+ `cli/kinemesh.cjs`，拷贝即用（0.9.4 起 viewer 内联，`render` 也自包含） |
| MCP server | `plugins/kinemesh/mcp/kinemesh-mcp.js` | stdio，单文件 ESM，与 DSH 工具同名同参 |
| 打包（推荐分发形式） | `npm run pack:skill` → `dist/kinemesh-<version>.zip` | 一个 zip 含 SKILL.md / CLI / MCP / 包内 README / VERSION |

- 依赖：Node ≥ 18；`info`/`analyze`/`skeleton` 零依赖，`render` 需要目标工程 `npm i playwright &&
  npx playwright install chromium`；
- 产物（截图/分析中间文件）缺省写到**当前工作目录**的 `.kinemeshtmp/run-<时间戳>-<pid>/`；
- 版本核对：`node cli/kinemesh.cjs --version`；
- MCP 配置示例（任意 MCP 客户端）：

```json
{ "mcpServers": { "kinemesh": { "command": "node", "args": ["<解压目录>/mcp/kinemesh-mcp.js"] } } }
```

## 安装（DSH 插件）

在 DSH 侧栏 **Plugins → Add plugin** 里粘一条 spec：

```
git+https://github.com/zh880517/dsh_plugins.git#main&path:/plugins/kinemesh
```

钉版本用包含构建产物的 commit（`npm run release:plugin -- --only kinemesh` 会打印）。

## 安装（第三方 Agent 工具：Skill / CLI / MCP）

**把插件目录链接发给对方的 AI 就能装**——GitHub 会渲染该目录的 README，里面的「安装 A」段就是
可执行步骤：

```
https://github.com/zh880517/dsh_plugins/tree/main/plugins/kinemesh
```

同一内容的独立说明书（更完整：自检清单 / 常见问题 / 链接安装 / 升级卸载）：

```
https://github.com/zh880517/dsh_plugins/blob/main/docs/plugins/kinemesh/install-skill.md
```

要点：装 3 个文件到 `~/.claude/skills/kinemesh` 或 `~/.codex/skills/kinemesh`（`SKILL.md` /
`agents/openai.yaml` / `cli/kinemesh.cjs`）→ `node cli/kinemesh.cjs --version` 校验 → 重启客户端；
`info/analyze/skeleton` 零依赖，`render` 需目标工程装 playwright。详见
**[install-skill.md](./install-skill.md)**。

## 边界

- `.max` 等私有工程格式不解析，会返回带离线转换指引的自愈文案；
- `.blend` / NIF / PSK / GR2 等长尾格式在后续里程碑接入 assimpjs 兜底，当前阶段同样给指引；
- 不做模型编辑 / 导出 / 重定向执行；
- 浏览器进程按次启停做截图，不做常驻服务。

## 数据与权限

- 不建数据库、不写 `~` 下任何目录；`kinemesh_info` 只读 Agent 给出的路径。
- 截图 / 分析中间文件 / 命令附件缺省写到**当前工作目录下的 `.kinemeshtmp/run-<时间戳>-<pid>/`**
  （0.9.2 起，不再散落到系统临时目录；`KINEMESH_TMP_DIR` 可覆盖根目录，cwd 不可写时自动退回
  系统临时目录，路径可显式指定）。

## 开发

```bash
npm run typecheck        # shared + 全部插件
npm test                 # tests/kinemesh/（合成资产为主，真实样例可选）
npm run build -- --only kinemesh
npm run check
```

测试资产：合成 FBX/glTF/GLB/OBJ 由 `tests/support/kinemesh-fixtures.ts` 内存生成（确定性、零依赖）；
真实样例放 `tests/fixtures/kinemesh/`（gitignore，缺文件时相关用例自动跳过），
例如 [three.js 仓库的 Samba Dancing.fbx](https://github.com/mrdoob/three.js/blob/dev/examples/models/fbx/)。

## 文档索引

- 架构与关键决策（M1–M7 全部里程碑）：[design.md](./design.md)
