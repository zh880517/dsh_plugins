---
name: kinemesh
description: 3D 模型/动画资源分析与截图 CLI。当任务涉及游戏模型资源（FBX/glTF/GLB/OBJ）——查动画片段清单、骨骼/网格统计、单位体检，或需要按视角渲染截图做视觉分析（动作姿势检查、模型审查、关键帧连拍），或动作文件不带 mesh 需要绑定独立 mesh 文件预览/截图时使用。
---

# kinemesh（动析）CLI

面向 AI Agent 的 3D 模型/动画资源分析与截图工具。本目录自包含：`cli/kinemesh.cjs` 是单文件
bundle（three.js 全内联），免 npm install，任何有 shell + Node ≥ 18 的环境直接 `node` 运行。

## 何时用

- 拿到模型文件，回答「这个资源有哪些动作、多长、能不能用」→ `info`
- 回答「这个动作在干嘛、多激烈、能不能循环」→ `analyze`（分段/facts/循环检测，一次产出中间文件）
- 需要看画面：按视角 + 帧号出截图，做动作姿势检查 / 模型审查 / 关键帧 contact sheet → `render`
- **动作文件不带 mesh**（游戏里动作单独导出、只有 `basic/*_skin.fbx` 之类有网格）→ `render` / `info` 加 `--mesh <网格文件>`；
  不传时工具会自动在同资产目录找候选网格文件并绑定（见下节）
- 检查单位是否可疑（FBX 厘米未换算）→ `info` 的 warnings 字段

## 前置

`info` / `analyze` / `skeleton` 无额外依赖。`render` 需要本机 playwright + chromium（在你的项目目录执行一次）：

```bash
npm i playwright && npx playwright install chromium
```

**自包含说明（0.9.4 起）**：`cli/kinemesh.cjs` 已把 three.js **和渲染用的 viewer 一起内联**，
整个技能目录只有 `SKILL.md` + `cli/kinemesh.cjs` 两个文件——直接拷到任意工程（或 `~/.claude/skills/`
这类技能目录）即可用，`render` 也不会再因为找不到 `viewer.js` 失败；唯一的额外前提是上面的
playwright（装在**你运行 CLI 的工程**里，CLI 按 Node 常规模块解析向上找）。
用 `node cli/kinemesh.cjs --version` 可以确认手上是哪一版。

## 命令格式

```bash
node <本目录>/cli/kinemesh.cjs info <file> [--mesh <mesh-file>]
node <本目录>/cli/kinemesh.cjs analyze <file> [选项]
node <本目录>/cli/kinemesh.cjs skeleton <file> [选项]
node <本目录>/cli/kinemesh.cjs render <file> [选项] [--mesh <mesh-file>]
node <本目录>/cli/kinemesh.cjs --version     # 手上是哪一版
```

`info`：输出模型结构信息 JSON——动画片段（名称/时长/通道数/根运动）、骨骼（数量/最大深度/是否人形）、
网格（三角面/顶点/蒙皮比例/材质数）、贴图、包围盒与单位体检。info 的 `rootMotion` 量的是
**根骨骼位移轨道的净位移**（Bip001 级，game 里常 false）；analyze 的位移口径用 **hips 关节**——
角色靠 hips 动画位移时（如 attack_04 走 1.2 身高）两者会不一致，以 analyze 的 `rootTotalDisp` 为准。

`analyze` 选项（DSH 工具 `kinemesh_analyze` / MCP 同名同参）：

| 选项 | 说明 |
|---|---|
| `--clip <name>` | 动画片段名（先 info 查）；缺省第一个 clip |
| `--clip *` | 批量分析全部 clips（返回 clips[]，中间文件按 &lt;clip&gt;/ 子目录分桶；与 `--range` 互斥） |
| `--range <t0,t1>` | 秒切片 [t0,t1]（0 ≤ t0 &lt; t1 ≤ 片段时长，先 info 查）；帧号仍按全片口径，结果可直接喂 render |
| `--detail <name>` | summary / standard / full（缺省 standard；full=+全部关节曲线） |
| `--curves-for <joints>` | 指定关节加出 motion-curves/&lt;joint&gt;.csv（逗号分隔） |
| `--sample-fps <n>` | 采样率 1–60（缺省 15） |
| `--smooth <n>` | 能量平滑窗口（采样帧，缺省 5） |
| `--joints <list>` | 关节清单（规范 id 或骨骼名）或 auto |
| `--loop-mode <name>` | strict / pose-only（bestLoopRange 口径，缺省 strict；verdict 恒 strict） |
| `--normalize <name>` | height / none（缺省 height，数值单位为身高倍数） |
| `--vocab <file>` | kinemesh-vocab.json 词汇表路径（缺省按 资产同目录 &gt; 工作区 &gt; builtin 发现） |
| `--bone-map <file>` | kinemesh-bones.json 映射文件路径（缺省按 资产同目录 &gt; 工作区 发现） |
| `--out <dir>` | 中间文件输出目录（缺省 `<当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/`；读不到时用它指向工作区重跑） |

强度档位口径（两列表见 motion-summary.json 的 constants）：**分段档 = max(均值档, 峰值档)**
（爆发短段不被均值稀释），**全片档只按均值**（整片节奏口径）——比较两部动画整体强度用全片档，
找爆发瞬间看分段档。

成功返回 `{ok, dir, files:[{name,bytes,what}], summaryDigest, warnings?, hint?}`：`summaryDigest`
内联分段表 + 全片统计 + loopCheck + **keyframeRender 配方**（关键帧号 × front/side × skeleton）；
产物缺省落在**当前工作目录下的 `.kinemeshtmp/run-<时间戳>-<pid>/`**（0.9.2 起不再散落到系统临时目录，
该目录通常在 host 的 `.gitignore` 里）——落在缺省目录时会带 `hint` 提醒。`render` 选项：

| 选项 | 说明 |
|---|---|
| `--mesh <file>` | **独立 mesh 文件（动作-only 资产）**：动画文件没有网格时，用它的网格做渲染主体、动画按骨骼名自动绑定；不传时自动识别同资产网格文件（basic/、`*_skin` 等），见下节 |
| `--clip <name>` | 动画片段名（先 info 查）；静态模型省略 |
| `--frames 0,15,30` | 帧号列表（≤64 个，按 30fps 换算 time=frame/30）；或 `--frame 30` 单帧 |
| `--view-preset <name>` | front / side / back / three-quarter / orbit8（八方位连拍） |
| `--azimuth/--elevation/--distance/--target x,y,z/--fov` | 自定义球坐标视角（与 preset 二选一） |
| `--mode <name>` | default / solid / wireframe / skeleton / bones-overlay；**省略 = 按模型自动选**（无 mesh→skeleton；贴图解不出来→solid 素模；有可用贴图→default。贴图缺失的资产用 default 会渲成黑剪影，这正是自动选要解决的） |
| `--bone-labels <batch>` | 骨骼名文字标注（B.4，与 `--mode skeleton` / `bones-overlay` 联用）：`auto`（第 1 批）/ 批次号（1 起，stride 分批防叠）/ `all`（全部骨骼名，允许重叠，调试） |
| `--width/--height` | 像素尺寸（缺省 1280×720） |
| `--out-dir <dir>` | PNG 输出目录（缺省 `<当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/`） |

**取景（0.8.0）**：只给 `--view-preset`（或什么都不给）时，**逐帧按当前帧身体包围盒精确取景**——
带 root motion 的动作（冲刺/突进/跳跃位移）不会跑出画面，身体漂移超过自身半径 15% 时 warnings 会提示；
显式给 `--azimuth/--elevation/--distance/--target/--fov` 则按你指定的**固定构图**渲染，不做逐帧跟拍。

### 动作文件不带 mesh：独立 mesh 文件（0.10.0；0.10.1 改为内容匹配）

游戏资产常把**动作单独导出**（例如 `<角色>/Animation/.../Attack.fbx` 只有骨架+动画、`meshes: []`），
角色网格在另一个文件（例如 `<角色>/Basics/<角色>_lod_Skin.fbx`）。这类文件直接 `render` 只能出骨架图；
加 `--mesh <网格文件>` 就会用它做网格主体、把动画按骨骼名绑定过去：

```bash
node cli/kinemesh.cjs render <动作.fbx> --mesh <网格.fbx> --clip "Take 001" --frames 0,2 --view-preset front
node cli/kinemesh.cjs info   <动作.fbx> --mesh <网格.fbx>
```

自动识别与绑定口径（都是工具确定性产出，直接引用即可）：

- **不传 `--mesh` 时自动识别（0.10.1：只看文件内容，不依赖文件名/目录名）**：在动作文件附近（本目录 /
  上一级 / 上两级，各向下 3 层、最多 400 个模型文件）先做便宜的内容探测——FBX 有 `Geometry` 节点、glTF 有
  `meshes`/`skins` 才算网格候选；再按**骨骼名覆盖率**（命中动作骨骼数 / 网格骨骼数）排序，取最高者绑定。
  `warnings` 里写明「已按文件内容自动识别同资产的网格文件「…」（骨骼命中 71/80（89%））」与其它候选；
  找不到则退回骨架并提示用 `--mesh` 显式指定。`info` 不带 `--mesh` 时也会列出同资产内容扫描候选。
- **角色自动识别**：`path` 提供动画、`--mesh` 提供网格；两个参数传反（path 有网格、mesh 文件有动画）也能自动纠正，
  `warnings` 会说明实际分配。两个文件都有网格时按 `--mesh` 的网格渲染并提示。
- **骨骼名绑定**：精确名优先，其次按命名空间归一化（`mixamorig:`、`Armature|` 等）匹配；**只导出部分骨骼的动作
  （例如 5 根脊柱的受击附加动画）也能绑定**——命中的骨骼被驱动，未命中的保持 rest 姿态；完全不匹配会三段式报错
  （提示两边来自同一套 rig、可分别 `info`/`skeleton` 对比骨骼名）。
- **根骨骼静止姿态差校正（0.10.1）**：同一套 rig 分两次导出时顶层被动画骨骼的静止朝向可能不同（典型：mesh 导
  Z-up、动作导 Y-up，FBXLoader 只给 mesh 根节点加 −90°X）。工具会把两边根骨骼的静止姿态差算进去（
  `binding.facts` 会写明「根骨骼静止姿态差校正：Bip001」），避免直接搬局部值导致角色「躺倒」；子骨骼局部值不动。
- **输出**：`render` 返回 `binding.plan`（`{mesh, animation}`）与 `binding.facts`（如「动画驱动 mesh 骨架的 71/83 根骨骼；轨道命中 213/213」）；
  `info --mesh` 返回 `companion`（网格文件的结构信息）+ `binding`（plan / report 命中统计 / facts / warnings / error）。
- 前提：两边来自**同一套 rig**（骨骼名能对上）。单位/比例差异不做自动换算——那属于重定向（retarget）范畴。

`skeleton` 选项（DSH 工具 `kinemesh_skeleton` / MCP 同名同参）：

| 选项 | 说明 |
|---|---|
| `--shots <name>` | auto（缺省，CORE15 有缺口才渲染标注截图）/ none（只出 report）/ all（全量批次） |
| `--bone-map <file>` | kinemesh-bones.json 映射文件路径（缺省按 资产同目录 &gt; 工作区 发现） |
| `--out <dir>` | 输出目录（缺省 `<当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/`；report 与 labels-*.png 都落这里） |

通用：`--out` 与 `--out-dir` 互为别名（所有子命令两个名字都接受）；**未知选项直接三段式报错**
（不静默忽略）——拼错选项名会立刻被告知，用 `--help` 查全部选项。

## 输出结构

- 成功：stdout 一行 JSON，`ok:true`。`info` 直接是信息对象；`render` 是
  `{"ok":true,"images":["绝对路径",…],"count":n,"warnings":[…],"hint":"…"}`——用你的读图工具逐张查看。
- 失败：stderr 一行 JSON `{"ok":false,"what":…,"guidance":…,"step":…}`（错在哪/正确姿势/当前这一步）
  + 非零退出码。

## 典型流程

1. `info` 拿到片段清单与体检 → 2. `analyze` 拿 digest + facts 叙述动作 → 3. 语义存疑按
   `summaryDigest.keyframeRender` 配方 `render` 关键帧 → 4. 读图互证后带依据输出（规则见下节）。

## 分工与防幻觉规则（重要）

三层分工，各层只做自己那层的事：

| 层 | 谁做 | 内容 |
|---|---|---|
| 数据层 | 工具（analyze） | 一切可计算的：派生通道、强度档位、label/guess、循环 verdict、facts、关键帧挑选 |
| 证据层 | 工具（render） | 关键帧/指定帧按视角渲染成图 |
| 语义层 | AI（你） | 基于中间文件 + 截图**推测**动作含义（像什么、在干嘛），组织自然语言 |

规则（逐条遵守）：

1. **你不计算数值**：不换算、不求均值、不比大小下结论。只引用文件/返回值里的数值，
   每个数字带单位与口径（哪根骨骼 / 哪个空间 / 是否身高归一化）。
2. **推测必须标注依据**：语义判断（「这像出拳」）要能指回数据（文件字段 / 帧号）或画面（截图）；
   工具的 guess 允许推翻，但推翻时必须引用文件里的数值。
3. **帧号可回溯互证**：analyze 的 frame 与 render 同口径（frame = t×30），数字与画面互为证据。
4. **分层披露，按需索取**：先读 `summaryDigest` / motion-summary.json → 要趋势读 motion-frames.csv →
   单关节深挖用 `--curves-for` 曲线 → 还不够再 `--detail full`。别一上来就要全量。

推荐工作流：

1. `analyze` 拿 `summaryDigest` + facts → 直接引用 facts 叙述（facts 是工具生成的中文事实句，数值勿改）；
2. 语义存疑：把 `summaryDigest.keyframeRender` 配方**原样**传给 render（关键帧 × front/side × skeleton）
   → 用读图工具逐张查看；
3. 带依据输出结论，例如「frame 12–28（segments #2，guess=strike-punch）：关键帧截图确认右直拳」；
4. 仍存疑就加大数据密度：`--detail full` / `--curves-for <joint>` / 换视角重渲。

### vocab 文件：guess 词表的记忆闭环

工具保持确定性、不联网不学习；可调整的是**数据**。在你服务的用户工程里维护 `kinemesh-vocab.json`：
用户反馈某段 guess 不对 → 你把修正记进词表 → 下次 analyze 确定性生效。

- 发现顺序：`--vocab` 显式指定 > 资产同目录 > 工作区 cwd > 仅内置；文件不存在静默降级，
  JSON/条目非法则报错（三段式）。summary 的 `vocab` 字段回显本次生效的词表来源与条目数。
- 格式（顶层为数组或 `{"entries": [...]}` 均可）：

```json
{
  "entries": [
    { "term": "dodge", "when": { "airborne": false, "rootSpeedMin": 1.2, "headingTurnMin": 45 }, "action": "label" }
  ]
}
```

- `when` 只允许引用工具已产出的段特征（防幻觉）：`airborne` / `rootSpeedMin` / `headingTurnMin` /
  `airRatioMin` / `peakJoint` / `peakEMin` / `durMax` / `meanEMin` / `meanEMax` / `turnTotalMin` /
  `bodyDir` / `hipsLow`；`{"anyOf": [{…}, …]}` 任一子条件组命中即可，不与其他字段混用。
- `action`：`label`（缺省，命中打 term）/ `suppress`（命中 guess 置 other，压误报）/ `demote`（降级 gesture）。
- 词条按序插在内置决策表前，首条命中生效（first-match）；命中只覆盖 guess，label（确定性层）不动。

### 骨架识别两级兜底（kinemesh_skeleton）

骨架识别与映射的分工（拍板 #12）：**工具只做字典查表（Mixamo/Biped/UE/VRM/Rigify/常见英文/少量拼音）
与约定识别**——不做模糊匹配、不做几何启发；识别缺口一律回退 AI（你）定案，结论由工具确定性消费。

标准命名 rig（字典全覆盖）调 `skeleton` 直达全映射，不出截图、不用你介入；非标命名（Bone01… /
四足 / 带翼 / 链形）走两级兜底：

1. **第一级（读数据）**：`skeleton <file>` 产出 `skeleton-report.json` + digest——每骨
   名称/层级/rest 世界坐标/partGuess/置信、convention 约定、映射覆盖（CORE15 n/15）、未映射清单、
   结构统计（limbChains/groundTips/symmetryPairs/maxChainDepth）。你先读 report **判 archetype**
   （humanoid/quadruped/winged/multiped/chain/custom），人形按名称/层级/rest 坐标对应部位；
   非人形给 root/head/脊柱/肢链（role: leg|arm|wing|tail）。
2. **第二级（读图，命名不透明才用）**：`skeleton <file> --shots all`（缺省 auto＝CORE15 有缺口才出）
   **直接产出标注截图** `labels-<view>-<两位批次>.png`（front/side × 每批，B.4 stride 分批防叠、
   每批 ≤12 骨）——骨骼名文字标签已画在关节旁，逐张读图即可定案，不必对照坐标猜名。
   需要 playwright + chromium；缺它时 skeleton 降级只出 report（digest.shotsWarning 给安装指引），
   可按 digest 批次清单用 `render --mode skeleton --bone-labels <批号> --frames 0
   --view-preset front|side` 手动出图（`--bone-labels` 批次按全骨架 stride 划分，与本报告
   auto 批次可能不同批，对齐批号以 report 的 `batches[].bones` 为准）。
3. **定案落盘**：把结论写 `<资产同目录>/kinemesh-bones.json`（schema 见 report 尾注；最小示例：）

```json
{
  "_meta": { "archetype": "humanoid", "by": "ai" },
  "bones": { "Hips": "hips", "Spine": "spine", "Head_01": "head", "Hand_L": "hand-l" }
}
```

   值只允许白名单 id：hips / spine / head / upperarm-l|r / lowerarm-l|r / hand-l|r /
   upperleg-l|r / lowerleg-l|r / foot-l|r / toe-l|r / neck / chest（side 必须显式，一个 id 一根骨骼）；
   非 humanoid 改给 root（必填）/head/spine/limbs，bones 字段忽略。
4. **确定性消费**：文件放资产同目录后，`skeleton` / `analyze` 重跑自动发现（`--bone-map` 可显式指定，
   路径不存在直接报错）——映射优先于字典，J15 解析按映射走、不再回退 Top-15，info 的 `bones.mapped`
   计数取映射。analyze/joints 的解析顺序：映射文件 > 字典查表 > Top-15 回退（回退时 warnings 附补映射指引）。

## 转换指引（明确不支持的格式）

- `.max`：3ds Max 私有格式，不解析。在 3ds Max 中 文件 → 导出 → FBX（勾选「烘焙动画」「嵌入媒体」）。
- `.blend`：建议在 Blender 中导出 GLB/FBX（带动画的先烘焙动作）。
- NIF / PSK / GR2 等引擎格式：离线转 GLB（FBX2glTF / Blender 导出）后再进本工具。
- 转换要点：约束/IK 必须烘焙成关键帧；FBX 动画层会被拍平；FBX 厘米 → glTF 米自动换算；
  动画关键资产用 FBX2glTF / Blender bpy 转换（不走 assimp，动画质量不稳）。
