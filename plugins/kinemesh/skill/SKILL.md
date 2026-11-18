---
name: kinemesh
description: 3D 模型/动画资源分析与截图 CLI。当任务涉及游戏模型资源（FBX/glTF/GLB/OBJ）——查动画片段清单、骨骼/网格统计、单位体检，或需要按视角渲染截图做视觉分析（动作姿势检查、模型审查、关键帧连拍）时使用。
---

# kinemesh（动析）CLI

面向 AI Agent 的 3D 模型/动画资源分析与截图工具。本目录自包含：`cli/kinemesh.js` 是单文件
bundle（three.js 全内联），免 npm install，任何有 shell + Node ≥ 18 的环境直接 `node` 运行。

## 何时用

- 拿到模型文件，回答「这个资源有哪些动作、多长、能不能用」→ `info`
- 需要看画面：按视角 + 帧号出截图，做动作姿势检查 / 模型审查 / 关键帧 contact sheet → `render`
- 检查单位是否可疑（FBX 厘米未换算）→ `info` 的 warnings 字段

## 前置

`info` 无额外依赖。`render` 需要本机 playwright + chromium（在你的项目目录执行一次）：

```bash
npm i playwright && npx playwright install chromium
```

## 命令格式

```bash
node <本目录>/cli/kinemesh.js info <file>
node <本目录>/cli/kinemesh.js render <file> [选项]
```

`info`：输出模型结构信息 JSON——动画片段（名称/时长/通道数/根运动）、骨骼（数量/最大深度/是否人形）、
网格（三角面/顶点/蒙皮比例/材质数）、贴图、包围盒与单位体检。

`render` 选项：

| 选项 | 说明 |
|---|---|
| `--clip <name>` | 动画片段名（先 info 查）；静态模型省略 |
| `--frames 0,15,30` | 帧号列表（≤64 个，按 30fps 换算 time=frame/30）；或 `--frame 30` 单帧 |
| `--view-preset <name>` | front / side / back / three-quarter / orbit8（八方位连拍） |
| `--azimuth/--elevation/--distance/--target x,y,z/--fov` | 自定义球坐标视角（与 preset 二选一） |
| `--mode <name>` | default / wireframe / skeleton / bones-overlay（骨骼可视化是动作分析刚需） |
| `--width/--height` | 像素尺寸（缺省 1280×720） |
| `--out-dir <dir>` | PNG 输出目录（缺省系统临时目录） |

## 输出结构

- 成功：stdout 一行 JSON，`ok:true`。`info` 直接是信息对象；`render` 是
  `{"ok":true,"images":["绝对路径",…],"count":n,"warnings":[…],"hint":"…"}`——用你的读图工具逐张查看。
- 失败：stderr 一行 JSON `{"ok":false,"what":…,"guidance":…,"step":…}`（错在哪/正确姿势/当前这一步）
  + 非零退出码。

## 典型流程

1. `info` 拿到片段清单与体检 → 2. 选关键帧 + 视角 `render` → 3. 读图分析 → 4. 需要 时换视角/模式再渲染。

## 转换指引（明确不支持的格式）

- `.max`：3ds Max 私有格式，不解析。在 3ds Max 中 文件 → 导出 → FBX（勾选「烘焙动画」「嵌入媒体」）。
- `.blend`：建议在 Blender 中导出 GLB/FBX（带动画的先烘焙动作）。
- NIF / PSK / GR2 等引擎格式：离线转 GLB（FBX2glTF / Blender 导出）后再进本工具。
- 转换要点：约束/IK 必须烘焙成关键帧；FBX 动画层会被拍平；FBX 厘米 → glTF 米自动换算；
  动画关键资产用 FBX2glTF / Blender bpy 转换（不走 assimp，动画质量不稳）。
