# kinemesh（动析）架构设计

> 状态：v0.10.4（**M1–M7 已实施**：M6 动作分析与 M7 骨架识别随 0.5.0 发布；0.6.0–0.9.x 为预览交互与
> 截图取景的连续迭代——三入口重构、播放条/轨道/速度、显示方式拆分、载入自动选模式、逐帧取景、
> root motion 开关与根节点参考轴、产物临时目录收口；0.10.0 新增**独立 mesh 文件绑定**，0.10.1 改为
> **内容匹配（骨骼覆盖率）**、0.10.2 格式/配对判定全收口到文件内容、0.10.3 补齐全拖拽自动配对、
> 0.10.4 绑定改为**世界姿态对齐烘焙**（bind pose/up-axis 差异下姿态与动画一致、脚落地）并加自动配对
> 覆盖率下限；独立预览页带**左侧层级列表**。逐条见 §6.10 / §6.11 与各条款括注的版本号）。
> M1 设计输入来自 `docs/dev/2026-11-18-kinemesh-design.md`（已按 docs/dev 生命周期删除）；
> M6/M7 设计输入来自 `docs/dev/2026-11-18-kinemesh-motion-analysis-design.md`（草稿 v0.1–v0.9，
> 经 14 条拍板决策定稿，结论已全部回写本文，草稿已删除）。本文是长期有效的正式文档。

## 1. 定位与三出口

**kinemesh = kine（运动/动画） + mesh（模型）**，中文展示名「动析」。
面向游戏 3D 模型/动画资源，服务三类场景：

1. **AI 读信息**：提取动画片段清单、骨骼结构、网格统计、比例/单位体检；
2. **AI 看画面**：按视角 + 帧号渲染截图，供 Agent 视觉分析；
3. **AI 推测动作内容**（M6，设计定稿）：工具产出确定性中间文件（通道/分段/循环归位/事实句），
   Agent 只读数据与关键帧截图做语义推测——**不计算数值**。

三个出口共用同一个 core，工具**同名、同参数、同返回结构**：

| 出口 | 载体 | 状态 |
|---|---|---|
| DSH 插件 | `plugins/kinemesh/`（host 工具 + client 预览面板） | M1 部分交付（仅 `kinemesh_info`），M3 完整 |
| Skill + CLI | Skill 目录 + 单文件 CLI bundle | M4 |
| MCP Server | stdio，zod schema 与 DSH 同名同参 | M5 |

工具共四个，均已实施：`kinemesh_info` / `kinemesh_render`（M1/M3）；`kinemesh_analyze`（M6）/
`kinemesh_skeleton`（M7）随 0.5.0 发布，契约见 §6.7 / §7.3。

## 2. 总体架构

```
plugins/kinemesh/src/
  host.ts          DSH Host 入口（inject: ['tools']；M3 追加 webServer 路由）
  tools.ts         Agent 工具（kinemesh_info；M2 追加 kinemesh_render；
                   M6/M7 追加 kinemesh_analyze / kinemesh_skeleton）
  client.tsx       DSH Client 入口（M1 占位；M3 预览面板；M6e 预览页）
  core/            与出口无关的纯能力层（不依赖宿主 API）
    registry.ts    格式注册表 + 未识别格式的自愈指引
    analyze-file.ts  顶层入口：buffer + 文件名 → InfoReport
    types.ts       CanonicalScene / InfoReport / FormatEntry
    errors.ts      KinemeshError（错在哪 + 正确姿势）
    loaders/       fbx（three FBXLoader）· obj · gltf（GLTFLoader，viewer 用）· node-textures
    analyze/       scene-info（场景→InfoReport）· gltf-json（纯 JSON 快速路径）
                   humanoid（人形命名惯例）· units（单位体检）
    motion/        M6（设计定稿）：sample / channels / normalize / segment / describe /
                   report——算法规格见附录 A
    analyze/bone-map.ts  M7（设计定稿）：命名归一 + 同义词字典 + 约定识别——见附录 B
```

新增格式 = 在 `FORMAT_ENTRIES` 注册一个 entry（`detect` magic 优先、扩展名兜底；可选 `fastInfo`
纯结构快速路径），工具层零改动。

## 3. M1 关键决策（已实施）

### 3.1 three.js 是构建期内联依赖

- 版本钉住 **three@0.187.0**（`@types/three` 同步钉版），放在根 `package.json` devDependencies；
- 层约束测试（`tests/aiworkflow/layering.test.ts`）的允许规则已从「硬编码 React/React Flow」
  改成「根 devDependencies ∪ 插件自己 package.json 声明的依赖」——构建期第三方依赖必须声明，
  运行期零安装（产物全内联）；
- shared/ 层不引入 three.js：kinemesh 的 core 全部放在插件目录内，不进 `shared/src/`。

### 3.2 Node 端解析：贴图桩 + manager handler

info 提取不需要解码位图，但 three 的 `TextureLoader/ImageLoader` 会碰 `document`。
`loaders/node-textures.ts` 在 Node 环境给 `LoadingManager` 按扩展名注册「立即返回空 Texture」的
loader（FBXLoader 与 GLTFLoader 都走 manager handler 分发），浏览器里不生效，viewer 贴图照常加载。
FBX 内嵌贴图的 `URL.createObjectURL(new Blob(...))` 在 Node 22+ 原生可用，无需 polyfill。

### 3.3 glTF 走纯 JSON 快速路径

`kinemesh_info` 对 glTF/GLB 不构造场景：`animations[].samplers` 的 accessor min/max（时长）、
accessor count/min/max（网格与包围盒）、nodes/children/skins（骨骼）全是纯 JSON。
Draco/Meshopt/KTX2 压缩不影响 info（不计三角面数以外的几何细节）。
CanonicalScene 路径（GLTFLoader）保留给 viewer / 截图（M2/M3）与动作分析（M6）。

### 3.4 rootMotion 取「净位移」

设计草稿说「根骨骼位移通道是否非零」。实施取**终态相对初态的净位移**（阈值 `max(1e-4, 模型高度×1%)`）：
原地动作的上下弹跳不算根运动，更贴近「能不能在游戏里复用」的判断。glTF 快速路径用输出 accessor 的
min/max 判断；FBX 场景路径解析根骨骼 position 轨道的首尾值。

### 3.5 单位体检与 fps 的边界

- 包围盒高度 > 10（模型单位）→ 报「疑似单位错误：像厘米未换算的 FBX」，阈值来自设计文档；
- FBX 的 GlobalSettings（UnitScaleFactor / fps）three 解析层不暴露，`meta.unitScaleFactor / fps`
  v1 恒为 null，`clips[].fps` 同样 null——不编造数据，等后续需要时加轻量 GlobalSettings 预读。

### 3.6 报错自愈（三段式）

`KinemeshError` 携带「错在哪 + 正确姿势」两段；工具层补第三段「当前这一步」。
`.max` 给 3ds Max 导出路径、`.blend` 给 Blender 导出/烘焙建议、NIF/PSK/GR2 给离线转 GLB 路线、
未知格式给支持范围。预期失败以 `{ ok:false, what, guidance, step }` 结构返回（Agent 可读），
非预期异常兜底为同构文案。

### 3.7 测试策略：合成资产为主

- `tests/support/kinemesh-fixtures.ts` 内存生成**最小二进制 FBX / ASCII FBX / 带动画的 glTF / GLB / OBJ**，
  确定性输出、零仓库体积；
- 真实样例（three.js 仓库 Samba Dancing.fbx 等）放 `tests/fixtures/kinemesh/`（gitignore），
  缺文件自动跳过——骨骼/人形识别/单位体检有真实数据兜底；
- 合成 FBX 是手写的最小二进制树，注意几个坑（也是读 FBX 文档的备忘）：
  节点头第二个 u32 是**属性数量**（不是子节点数，子节点靠 endOffset 截断）；
  数组属性头是 3×u32（length/encoding/compressedLength）；多边形顶点要按
  **从外侧看逆时针**排（绕向反了 FrontSide 裁剪会让整个网格正面不可见）。
  ASCII 文本的探测有陷阱：TextParser 会把任何不认识的行当数组续行，而 `isFbxFormatASCII`
  又在固定位置比对二进制 magic——头注释的形状有讲究（见 fixtures 注释）。

### 3.8 M2：viewer 模块与截图管线

- **`core/viewer/kinemesh-viewer.ts`**：框架无关，`mountViewer(container)` → handle
  （loadScene / applyView / getViewState / play / pause / seekFrame / frameInfo / sceneBounds）。
  OrbitControls 拖转后经 `cameraFromPosition` 反解回球坐标 ViewState；时间轴用 AnimationMixer，
  **帧号统一按 30fps 换算**（`RENDER_FPS`，源 fps 拿不到时的约定）。DSH Client 预览面板（M3）
  与截图页加载同一模块——「预览里看到的构图 = AI 截图拿到的画面」。
- **`src/viewer-page.ts` → `viewer.js`（约定产物）**：构建脚本为存在该入口的插件多打一个
  IIFE（three.js 全内联、浏览器独立可跑）。`render/screenshot.ts` 运行时把它内联进独立
  HTML（不依赖 node_modules），Playwright(chromium) 打开 → 桥接 `window.__kinemeshViewer`
  → 载入模型 → 逐帧截图 → PNG 落盘返回绝对路径。浏览器按次启停，无常驻服务（红线）。
- **截图确定性**：`applyView`/模式切换后同步 render 一帧（截图不等下一个 rAF）；
  `seekFrame` 在「渲染完该帧」后才 resolve。
- **实现备忘（都是踩过的坑）**：AnimationAction 置 `paused=true` 会把 effectiveTimeScale 归零，
  `mixer.setTime` 的 scrub 无效——循环里用播放守卫而不是 paused；FBX 缺 LayerElementNormal 时
  Phong 材质渲染成纯黑，载入时对缺法线的几何补 `computeVertexNormals()`。
- **orbit8**：解析层展开为 8 个方位角（每帧 × 8 张）；`view`/`viewPreset` 二选一在
  `core/viewstate.ts` 校验并给自愈文案。
- **依赖**：playwright 钉在根 devDependencies（0.1.x），chromium 由 `npx playwright install chromium`
  安装；DSH 插件出口在宿主没有 playwright 时给出安装指引（M3 工具层降级）。
- **构建必须把 playwright 外置（0.8.0，真实事故）**：会话 session-cd962a54 里 DSH 插件的
  `kinemesh_render` 直接失败——`Cannot find module ...\plugins\kinemesh\playwright-BLPky7o0.js`。
  原因：宿主半 `await import('playwright')` 被 rollup 内联成**懒加载 chunk**，而构建只拷出单文件
  index.js，chunk 文件不存在。修法：`buildHost` 的 `rollupOptions.external` 加 `playwright`，
  保持运行时真动态 import（Node 从插件目录向上解析，仓库/安装环境的 node_modules 都能命中）；
  另加 `assertNoLostChunks()` 守卫，产物里再出现 `import("./xxx.js")` 这类懒 chunk 引用直接构建失败。
- **截图默认自动化（0.8.0，同一会话暴露的两个问题）**：
  - **未指定 mode 时按模型自动选**（与预览面板同一套 `auto-mode.ts` 规则）：无 mesh → skeleton；
    贴图解不出来 → solid；有可用贴图 → default。此前缺省写死 `default`，真实资产
    `1012_tahlia attack_01` 的 4 张贴图全部解不出 → 截图整具**纯黑剪影**，AI 只能改走 CLI。
    显式传 mode 则以调用方为准；结果 warnings 会写「未指定 mode：按模型自动选 solid（…）」。
  - **只给视角预设时逐帧自动取景**：root motion 动作（冲刺/突进/跳跃位移）用**载入时的静止包围盒**
    算机位会跑出画面——同一资产第 36 帧角色冲到镜头前，截图只剩腰和半截手臂（「截图默认截取不到」）。
    实现：`core/viewer/scene-bounds.ts` 按**当前帧蒙皮结果**算包围盒（`SkinnedMesh.computeBoundingBox`
    含蒙皮变形 + `matrixWorld`），`viewer.fitCameraToSubject()` 用**精确透视取景**（包围盒 8 角投影
    逐角反推距离，再留 8% 余量）对准当前帧；显式传 `view` 则尊重调用方的固定构图。
    身体漂移超过自身半径 15% 时在 warnings 里提示「该片段带位移」。真实验证：同一资产 6 帧
    触边像素 0、模型像素 46k–60k 稳定（修前第 36 帧只剩半截）。
  - 回归：`tests/kinemesh/scene-bounds.test.ts`（当前帧包围盒 / 父级变换 / 隐藏对象跳过）、
    `screenshot.int.test.ts` 新增「省略 mode 自动选 + 只给预设逐帧取景、显式 view 不跟」用例。
- **测试**：`tests/kinemesh/screenshot.int.test.ts` 用合成 FBX 走真实 chromium 渲染
  （两帧内容不同、尺寸正确、orbit8 八张、空 frames 报错）；chromium 缺席时整组跳过。

### 3.9 M3：DSH 插件完整链路

- **工具**：`kinemesh_info` + `kinemesh_render`（png 落盘返回绝对路径数组——设计文档的稳妥路径，
  Agent 用读图工具查看；playwright 缺席时给安装指引，info 不受影响）。
- **路由**（`/kinemesh` 前缀，CORS 放行同 aiworkflow）：
  - `GET /kinemesh/model?path=…`：给预览面板供模型字节（512 MiB 上限，octet-stream）；
  - `GET /kinemesh/info?path=…`：轻量 InfoReport；
  - `GET /kinemesh/analysis?path=…&clip=…`（M6e）：预览曲线数据源（digest/分段/关键帧/能量，内存返回）；
  - `GET /kinemesh/companions?path=…`（0.10.0）：动作-only 文件的同资产候选网格文件（命名/目录启发式，
    不解析内容；客户端逐个加载校验 meshes 非空后绑定，见 §6.11）。
  - `POST /kinemesh/analyze`：**「发送给 AI 分析」**的宿主入口——Client 把当前路径/片段/帧号/
    ViewState 描述 POST 上来，Host 用 `ctx.get('agents').get(sessionId).followup({role:'user',…})`
    唤醒该会话 Agent（与 aiworkflow / 定时提醒同一机制；设计草稿里的 `agent.inject/followup`
    经 cordis_inspect 验证后落定为此形态）。Agent 收到的消息明确指示它调 `kinemesh_render`
    渲染该视角并读图分析——闭环「收到视角 → 截图 → 分析」。Agent 不在线时回 409 + 自愈文案。
    0.10.0 起请求可带 `mesh`（预览面板已绑定的独立网格文件），消息里写明绑定网格文件、指示 render 传该参数。
- **面板入口形态**（草稿 §10 开放问题的决定）：参照 aiworkflow 的模式——输入框左侧「动析」胶囊
  + 浮层预览对话框，不占主面板。浮层内：路径加载、clip/渲染模式选择、帧滑条与播放、
  视角实时回读（OrbitControls 拖转 → 球坐标 ViewState）、发送按钮。
- **client 依赖的宿主模块**：`dsh.client.inject: ['@deepseek-ai/dsh-client-ui-conversation']`
  （输入框/浮层槽位都在会话 UI 包里）。预览直接内联 viewer 模块（client.js ≈ 1.7 MiB）。

### 3.10 M4：Skill + CLI

- **技能目录**：`plugins/kinemesh/skill/` = `SKILL.md + cli/kinemesh.cjs`，复制目录即用（草稿 §5.2）。
  落点决定（草稿 §11 开放问题的决定）：技能目录放在插件目录内（`plugins/<id>/skill/`），
  不进 DSH 安装包（package.json `files` 不含它），随仓库分发。
- **CLI 产物**：`src/cli.ts` → `skill/cli/kinemesh.cjs`（构建约定第四产物）：单文件 CJS + shebang，
  three.js 全内联、免 npm install；playwright 保持外部依赖（render 前置，SKILL.md 写明）。
  **用 `.cjs` 而不是 `.js`**：技能目录会被拷进任意工程，宿主 `"type":"module"` 不会把它当 ESM。
  构建脚本给 CLI 关闭了 node: 内建的 browser 桩（`external: [/^node:/]`），否则 `path/fs` 全变空壳。
- **自包含修正与打包（0.9.4，真实缺陷）**：交付 0.9.3 的 Skill 时实测发现——只拷
  `SKILL.md + cli/kinemesh.cjs` 时 `render` 直接报「找不到 viewer 产物（viewer.js）」，
  「技能目录复制即用」只对 `info/analyze/skeleton` 成立。修法：构建期把本次构建出的
  `viewer.js` 以 `__KINEMESH_VIEWER_INLINE__` 字符串**内联进 CLI 与 MCP 产物**
  （`readViewerBundle()` 优先用它，宿主 index.js 不注入、仍按文件位置找）；
  CLI/MCP 体积相应涨到 ~3MB/3.8MB，但换来自包含。
  另加 `node ... --version`（构建期注入 `__KINEMESH_VERSION__`）供第三方核对版本，
  以及 `npm run pack:skill` → `dist/kinemesh-<version>.zip`（自带 store-only ZIP 写入器、
  不引依赖；包内 SKILL.md / cli / mcp / 包内 README / VERSION）。
  实测：解压后 `cli/kinemesh.cjs analyze` 与 `--version` 正常，`render` 在含 playwright 的工程里可出图。
- **安装到 Agent 全局技能目录（0.9.5）**：Skill 目录用 **junction** 挂到 `~/.claude/skills/<id>` 与
  `~/.codex/skills/<id>`（`scripts/install-skill.ps1`，支持 `-Uninstall`；脚本用 UTF-8 BOM 保存，
  Windows PowerShell 5.1 与 pwsh 7 都能跑），源码即事实源、重建立即生效。Codex 侧额外提供
  `skill/agents/openai.yaml`（`interface.display_name/short_description/default_prompt` +
  `policy.allow_implicit_invocation`，规范来自 Codex 内置 skill-creator 的 references/openai_yaml.md），
  打包时一并进 zip。
  同时修了链接调用下的真 bug：CLI 的「是否直接执行」判定原先比较 `argv[1]` 与 `__filename` 的
  **字面路径**，经 junction 调用时前者是链接路径、后者是 Node 解析后的真实路径 → 判定为 false，
  **CLI 静默什么都不做**。现在两侧都先 `realpathSync` 再比较（0.9.5）。
- **对外安装说明（0.9.6）**：新增 [install-skill.md](./install-skill.md)——面向**第三方 AI Agent 自己装**
  的单文档说明（可直接把 GitHub 链接丢给对方 Agent）：目标目录（Claude/Codex 全局技能目录）、
  raw 下载命令（PowerShell + bash）、`--version`/`info` 自检清单、MCP 可选安装、链接安装、
  升级卸载、常见问题（含「raw 链接跟随 main、务必核对版本」与旧版 junction 静默 bug）。
  根 README「安装」、docs/README「单主题文档」、插件 README 都已链过去。
- 契约：成功 stdout 一行 JSON（ok:true）；失败 stderr 三段式 JSON + 非零退出码；
  `info <file>` / `render <file> --frames 0,15,30 --view-preset front --mode skeleton --out-dir …`。

### 3.11 M5：MCP Server

- **MCP 产物**：`src/mcp-server.ts` → `mcp/kinemesh-mcp.js`（构建约定第五产物）：单文件 ESM，
  MCP SDK（@modelcontextprotocol/sdk 1.32）+ zod 4 + core 全内联；playwright 保持外部依赖；
  stdio 传输。原位运行（ESM 依赖同目录 package.json），配置片段见 [mcp/README.md](../../plugins/kinemesh/mcp/README.md)。
- 工具同名同参：schema 用 zod 定义并映射 DSH / CLI 的参数口径；缺参数不走 SDK 协议错误，
  而是在 handler 里返回 `isError` + 三段式 JSON（与 CLI / DSH 工具的自愈口径一致）。
- 集成测试直接 spawn 产物走 stdio JSON-RPC：initialize → tools/list → tools/call 全链路。

## 4. 数据流

```
模型文件 (ArrayBuffer + fileName)
  → detectFormat(head, fileName)               # registry
  → fastInfo?                                  # glTF/GLB：纯 JSON → InfoReport
  → load() → CanonicalScene                    # FBX/OBJ：three 场景
  → sceneToInfo(scene)                         # 场景 → InfoReport
  → kinemesh_info 返回 { ok:true, ...report }  # JSON

动作分析（M6，设计定稿）：CanonicalScene + AnimationClip
  → core/motion 采样/通道/分段/描述（附录 A）
  → 中间文件集 + summaryDigest                  # kinemesh_analyze，见 §6

骨架映射（M7，设计定稿）：骨骼名归一 → 同义词字典 → skeleton-report / 标注截图
  →（AI 兜底：读 report/图 → 写 kinemesh-bones.json）→ joints 解析链   # kinemesh_skeleton，见 §7
```

InfoReport 结构（三出口共用）：`format / fileName / fileSize / clips[]（name, duration, fps,
channels, rootMotion）/ bones（count, maxDepth, humanoidLike）/ meshes[]（name, triangles,
vertices, skinnedRatio, materials）/ textures[]（name, size, embedded）/ bounds（min, max,
heightMeters）/ warnings[]`。

## 5. 里程碑与开放问题

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | core：Loader 注册表 + info 提取（FBX/glTF/OBJ） | ✅ 已实施（0.1.0） |
| M2 | viewer 模块 + 截图管线（Playwright，按次启停） | ✅ 已实施（0.2.0） |
| M3 | DSH 插件完整链路（预览面板 + 发送给 AI + `kinemesh_render`） | ✅ 已实施（0.3.0） |
| M4 | Skill + CLI 打包（单文件 CLI + SKILL.md） | ✅ 已实施（0.4.0） |
| M5 | MCP Server（stdio） | ✅ 已实施（0.4.0） |
| M6 | 动作分析：`kinemesh_analyze` + 中间文件集 + 循环/归位 + 预览页（§6、附录 A） | ✅ 已实施（0.5.0） |
| M7 | 骨架识别与映射：`kinemesh_skeleton` + kinemesh-bones.json + archetype（§7、附录 B） | ✅ 已实施（0.5.0） |

> 三出口的工具契约以 `core` 为准：同名（`kinemesh_info` / `kinemesh_render` / `kinemesh_analyze` /
> `kinemesh_skeleton`）、同参数口径、同返回结构；DSH 的 JSON Schema、CLI 的 flag、MCP 的 zod
> 分别投影自同一套 core 入参（`core/viewstate.ts` 的 `resolveView` 负责校验与缺省）。

开放问题（M1 草稿）的处理约定：

- 预览面板入口形态（0.6.0 重构后为三入口：左侧侧边栏「动析」独立预览页 / `/kinemesh` 命令启动会话分析 /
  会话内「模型预览」页签；原「输入框左侧胶囊 + 浮层预览」已移除，详见 §6.10）；
- 截图输出目录（0.9.2 改）：`kinemesh_render` 的 `out` 参数可指定；缺省
  **`<当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/`**——原先落到系统临时目录
  `<tmp>/kinemesh-shots/…`（Windows 上 `AppData\Local\Temp\…`）产物散落不好找；
  现在统一在 cwd 下的隐藏目录，且已进 `.gitignore`；`KINEMESH_TMP_DIR` 可覆盖根目录，
  cwd 不可写（只读工作区）时自动退回系统临时目录；
- 性能预算：`kinemesh_info` / 模型路由文件上限 512 MiB，info 工具超时 60s，render 工具超时 180s，
  一次渲染 ≤ 64 帧，页面操作超时 60s；
- BVH 重定向 / 多模型同场景对比：v1 不做；
- 长尾格式（.blend 等）assimpjs 兜底：暂缓（当前给离线转换指引），注册表已为它留好位置。

M6/M7 的 14 条拍板决策见 §8。

## 6. M6 动作分析（已实施）

### 6.0 调研结论（为什么自建）

**没有可直接采用的现成工具**。逐个核对过：

| 候选 | 是什么 | 为什么不采用 |
|---|---|---|
| [FBXMotionToolkit](https://github.com/matRandall/FBXMotionToolkit) | Python 的 FBX 运动数据提取/分析库：关节旋转/位移（全局+局部）、Butterworth 滤波、相似度、CSV 导出 | **最接近的一个**。但 Python 运行期依赖与「产物全内联、零安装」冲突；只有数据层，没有定性描述层 |
| [NVIDIA Kimodo motion_rep/feet](https://research.nvidia.com/labs/sil/projects/kimodo/docs/_modules/kimodo/motion_rep/feet.html) | 脚部接触检测：高度+速度双阈值启发式 | PyTorch 库。**算法直接借用**（就是几行阈值逻辑），不引依赖 |
| [Unimotion](https://searchworks-lb.stanford.edu/articles/edsarx__edsarx.2409.15904) / [Motion2Language](https://ar5iv.labs.arxiv.org/html/2310.10594) | 深度模型：帧级动作文本描述（「哪一帧在干嘛」） | 需求真实存在的好证据；但模型重、非确定、不可审计——与「不让 AI 编数据」的目标**正好相反**，明确不采用 |
| [pybvh](https://pypi.org/project/pybvh/) | BVH 读取/FK/重采样 NumPy 库 | 只吃 BVH，主路径是 FBX/glTF；且是 Python |
| [MoRTE-Laban](https://github.com/Physical-User-Modeling-PhyUM/MoRTE-Laban) | Kinect/MediaPipe/AMASS → Labanotation 自动标注 | 输入源不符（视频/动捕标记），研究原型 |
| [threenative-animation-mcp](https://socket.dev/npm/package/threenative-animation-mcp) | 动画**编辑**向 MCP（rig 检查、挂道具、改 clip） | 邻居工具，无动作内容分析/描述能力 |
| PME（感知运动能量）[三角形分段专利](https://patents.google.com/patent/US20040136460) | 能量曲线在局部极小处切分、取关键帧 | **思路直接借用**（分段算法同源） |

**决定**：在 kinemesh core 自建 `core/motion/` 确定性分析模块。全部算法是经典启发式（FK 采样、
数值导数、双阈值接触检测、能量曲线切分、姿势距离），复杂度低、确定性、可测试；加载、AnimationClip、
人形命名惯例、身高归一这些底座在现有 core 里**全部已有**。

### 6.1 需求与三层分工

需求：给定动作文件，分析出**动作内容**——「FrameX–FrameY 在干嘛」、强度（激励程度）、运动方向；
另用近似姿势对比回答**是否循环、是否归位**（见 §6.5）。最终由 Agent 组织成整段动作的自然语言描述。

核心约束（用户拍板口径）：**AI 不自己计算数值，而是根据一组数据来推测；能用工具生成的就用工具
生成**。三层分工：

| 层 | 谁做 | 内容 |
|---|---|---|
| 数据层 | 工具（analyze） | 一切可计算的：派生通道、档位、label、verdict、guess、facts、关键帧挑选 |
| 证据层 | 工具（render） | 关键帧/指定帧按视角渲染成图 |
| 语义层 | **AI** | 基于中间文件 + 截图**推测**动作含义（像什么、在干嘛），组织自然语言 |

设计原则：

1. **能用工具生成的就用工具生成**：数值、数字→定性词的映射（阈值→label/verdict）、事实句、
   关键帧挑选、渲染配方，全部工具产出——幻觉高发环节不给 AI 留空间；
2. **AI 不计算**：不换算、不求均值、不比大小下结论，只引用文件数值（每个数字带单位与口径：
   哪根骨骼/哪个空间/是否归一化）。写进 SKILL.md 与工具描述的「规则」段；
3. **推测允许且是 AI 的本职，但必须标注依据**：语义判断（「这像出拳」）要能指回数据
   （文件字段/帧号）或画面（截图）；工具 guess 可推翻，推翻时引用数值；
4. **帧号可回溯互证**：frame 号与 `kinemesh_render` 同口径（30fps 约定），数字↔画面互为证据；
5. **分层披露**：summary → segments → per-frame CSV → 关节曲线，按需索取；`kinemesh_analyze`
   的参数就是「Agent 想要什么数据」的表达方式（用户原话：让 Agent 控制参数输出不同文件）。

**AI 分析工作流（推荐链路，写进 SKILL.md）**：
`analyze`（拿 digest + facts）→ 引用 facts 叙述 → 语义存疑时按 digest 的 **keyframeRender 配方**
调 `kinemesh_render`（关键帧 × 建议视角/模式）→ **读图识别** → 带依据输出结论，例如
「frame 12–28（segments #2，guess=strike-punch）：关键帧截图确认右直拳」。仍存疑就加大数据密度：
`detail=full` / `curvesFor` 指定关节 / 换视角重渲。

### 6.2 数据流与模块

```
core/motion/
  sample.ts      headless 采样：AnimationClip 逐 track evaluate → 骨骼局部姿态
                 → updateMatrixWorld() → 每帧世界关节点矩阵（含 t=0 与 t=duration 精确端点）
  channels.ts    派生通道：速度/加速度/能量/朝向/接触/幅度（数值导数 + 双阈值）
  normalize.ts   归一化：以包围盒身高为 1（单位体检告警时降级 raw + warning）
  segment.ts     分段：能量曲线平滑→局部极小切分 + 接触/腾空硬边界 + 静止段合并
  describe.ts    阈值→标签：强度档位、方向词、分段类型 guess、循环/归位 verdict
  report.ts      中间文件落盘（JSON/CSV/SVG）+ summaryDigest
```

关键实现口径：

- **headless，不依赖浏览器/Playwright**：three 在 Node 里 `updateMatrixWorld` 即可采样（`info` 的
  FBX 路径已证明场景可在 Node 构造）。分析工具的依赖门槛与 `kinemesh_info` 相同。
- **glTF/GLB 分析走完整加载路径**（GLTFLoader，与 viewer 同款），不走 info 的纯 JSON 快速路径
  （快速路径只有 min/max，无法逐帧采样）。
- 采样率 `sampleFps` 缺省 15（30s 动作 = 450 帧），上限约束 `duration × sampleFps ≤ 24000`。
- 输出圆整 3 位小数；归一单位为「身高的倍数」，速度为「身高/秒」——跨资产可比且与单位体检解耦。
- **场景缓存**：host / CLI 进程内 `path+mtime → 加载实例` 缓存，analyze / render / 面板
  重复加载同一资产不再重复解析；采样后**必须恢复 rest 姿态**（A.1 快照从兜底升级为必经步骤）。

### 6.3 派生通道（每采样帧）

> 本章是概览；**每条通道的精确公式、常数与边界处理见附录 A**（A.2–A.6），实现以附录为准。

| 通道 | 定义 | 用途 |
|---|---|---|
| `energy` | Σ_j w_j·\|v_j\|，w 末端关节权重高、躯干低 | 强度曲线、分段、激励程度 |
| `root` | 根位置 x/y/z（世界，减初值） | 位移轨迹、归位位置分量 |
| `heading` | 角色朝向角（躯干/髋朝向投影） | 转身检测、归位朝向分量 |
| `moveDir` | 平面位移方向 → 8 方位词（相对初始朝向） | 运动方向 |
| `moveDirBody` | 平面位移方向 → 8 方位词（相对**当前**朝向） | 倒退 / 侧移（strafe）判定 |
| `moveSpeed` | 根平面速度（身高/秒） | 走/跑/静止分档 |
| `contactL/R` | 脚部高度 + 速度双阈值（Kimodo 同款启发式） | 步态、支撑相、腾空 |
| `airborne` | 双脚同时离线且 y 上行 | 跳跃段 |
| `amplitude` | 主要关节到躯干轴平均距离 | 姿态张度（「激励」的第二维度） |
| `topJoint` | 本帧线速度最高的关节名+值 | 打击肢端识别（拳/脚） |

关节集合：`joints=auto` 时人形资产取惯例集（head/spine/hips/双上臂/双前臂/双手/双大腿/双小腿/双脚，
复用 `analyze/humanoid.ts`）；非人形取「运动幅度 Top-N 骨骼」并在 summary 里说明口径。
J15 的**按名解析**在 M7（§7）落地后升级为：**映射文件 > 字典查表 > AI 兜底流程（产出映射文件）>
motion-top15 回退**。

### 6.4 中间文件集（一次 analyze 一个目录）

| 文件 | 内容 | Agent 用法 |
|---|---|---|
| `motion-summary.json` | clip 元数据、全片统计（能量 P50/P90/max、总位移、主方向、腾空/接触统计、`events[]` 事件时间轴）、分段清单、关键帧号、`loopCheck`（§6.5）、**facts 中文事实句数组** | 第一入口 |
| `motion-frames.csv` | 每采样帧一行：frame,time,energy,energyLevel,root_x/y/z,heading,moveDir,moveDirBody,moveSpeed,contactL/R,airborne,topJoint… | 查具体帧、趋势叙述 |
| `motion-segments.json` | 每段 `{frameStart, frameEnd, label, guess, features{峰值能量/方向/位移/接触, basis}}`；label 确定性（air/idle/…），语义化的 strike/walk 等放 `guess` | 「FrameX–FrameY 在干嘛」的直接素材 |
| `motion-keyframes.json` | 代表帧（能量/幅度极值 + 分段边界 + bestLoopRange/循环 seam 边界，≤8 帧）+ 中文 notes + renderRecipe | 关键帧渲染识别的选帧依据（配方同步内联进 digest，见 §6.7） |
| `motion-curves/<joint>.csv` | 指定关节的通道明细（`curvesFor` 参数触发） | 单关节深挖 |
| `motion-trajectory.json` | 归一化平面轨迹点列 + 步点标记 | 位移轨迹数值 |
| `motion-trajectory.svg` | 俯视图：路径折线 + 起点/终点标记 + 步点 + 按能量着色（手写轻量 SVG，无栅格化依赖） | 可视图；图像工具不支持 SVG 时读 json 或用 render 互证 |

**facts 机制（防幻觉的关键）**：工具生成**中文**短事实句（每段一句 + loopCheck 一句），例如
`"frame 0–14: 双脚接触, 能量低(0.08), 位移 0.02 身高, 方向 原地"`、
`"循环检测: loop-pose-only——姿势与位置回到起点, 但末帧速度与首帧差 0.31 身高/s, 循环会有顿挫"`。
Agent 的推荐工作流 = **引用 facts 重写成自然语言**；要推翻 label 必须引用文件里的数值作为依据。
label 英文、notes/facts 中文（用户拍板）。

**输出目录**（0.9.2 改）：缺省 **`<当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/`**
（与 render 一致，用户拍板；不再落到系统临时目录）。配套两条防读不到的措施：① 工具返回内联
`summaryDigest`（分段表+全片统计+loopCheck），常见情况 Agent 不必读文件；② Agent 读产物目录文件
被沙箱挡时，报错自愈指引「用 `out` 参数重跑指向工作区」。DSH 预览面板走 host 路由取数，不经文件（见 M6e）。

### 6.5 近似姿势对比：循环 / 归位检测

> 用户定位（拍板）：近似 pos 不用于「像什么动作」的语义判断，而用于回答两个资产复用性问题——
> **是否循环**（首尾能否无缝衔接反复播放）、**是否归位**（动作结束是否回到起始姿态/位置/朝向）。

#### 6.5.1 姿势描述子 P(t)

对每个采样帧构造 scale-free、可直接比大小的向量：

1. 取该帧世界关节位置（§6.2 采样已有）；
2. 减去根关节位置、绕竖直轴反向旋转 `heading(t)` → **角色局部系**（剥离位移与转身，只比姿势本体
   ——原地循环和 root-motion 位移循环能得到同样的姿势结论，由 verdict 的位置分量区分）；
3. 除以身高归一。

关节子集与 §6.3 的 `joints` 一致（人形 = J15 惯例集）。

#### 6.5.2 距离与四个分量

> 精确公式（P(t) 构造、旋转、RMS、bestLoopRange 打分）见附录 A.10；本章保留语义与阈值。

- `poseDistance(a,b)`：RMS（整体差异）+ `maxJoint`（最差单关节差，身高倍数）+ top3 最差关节清单
  （指名道姓，如「左手末端差 0.12 身高」——给动画师可操作的反馈）；
- `rootDisplacement`：首帧→末帧根平面位移（身高倍数）；
- `headingDiff`：末帧 − 首帧朝向角（度）；
- `velocitySeam`：末帧与首帧的关节平均速度差（身高/秒）——**循环有没有顿挫取决于速度连续性，
  不只是姿势**，这是「归位了但不能循环」的判别点。

采样对齐细节：seam 比较用**精确端点** t=0 与 t=duration 各评估一次，不吃采样网格的量化误差。

#### 6.5.3 判定（固定阈值，初值待合成资产校准）

| 分量 | 通过线 | 说明 |
|---|---|---|
| poseDistance RMS | < 0.03 | 姿势整体回起点 |
| poseDistance maxJoint | < 0.08 | 没有单关节明显偏差 |
| rootDisplacement | < 0.05 | 位置归位 |
| headingDiff | < 10° | 朝向归位 |
| velocitySeam | < 0.10 身高/s | 速度连续（无顿挫） |

三个布尔（`poseMatch` = 姿势+朝向过线；`positionMatch` = 位移过线；`velocityMatch` = 速度过线）
组合成四种 verdict（工具产出，四选一）：

| verdict | 条件 | 含义 / 典型资产 |
|---|---|---|
| `loop-perfect` | pose ∧ position ∧ velocity | 可无缝循环（走路循环、待机呼吸） |
| `loop-pose-only` | pose ∧ position ∧ ¬velocity | 姿势回起点但速度断裂——循环会有顿挫（收招后停顿一拍的动作） |
| `return-only` | pose ∧ ¬position | 姿势归位、位置漂移——root-motion 位移动作，复用要代码处理位移 |
| `no-return` | ¬pose | 不归位（一次性动作：死亡、倒地、受击落僵直） |

#### 6.5.4 最优循环区间扫描（bestLoopRange）

intro–loop–outro 结构的片段（如 0–5 帧起手、5–30 帧才是真循环体），首尾 seam 不合格但**内部**
存在可循环区间。算法：全片帧对 (i,j)，j−i ≥ 0.5s（N > 300 时等距抽稀到 300 网格），按 A.10 的
归一化 max 打分取最小。仅当最优 seam 过线才输出 `{frameStart, frameEnd, score, components}`，
并同步进 keyframes（区间两端是截图核对的最佳帧对）。root-motion 步伐循环用 `loopMode:"pose-only"`
才能找到循环体（见 A.10）。

#### 6.5.5 输出

全部进 `motion-summary.json` 的 `loopCheck` 块：
`{referenceFrame: 0, poseMatch, positionMatch, velocityMatch, components{各分量原值+阈值}, verdict,
worstJoints[], bestLoopRange?}` + 一条 facts 事实句。`bestLoopRange?` 无合格区间时序列化为
null（字段恒在）。阈值常量与强度档位同管理：内置、随输出回显、
可审计、不开放参数（用户拍板固定）。

### 6.6 分段、强度与词汇表

#### 6.6.1 分段算法

> 六步精确流程与显著性定义见附录 A.7；段特征与 label/guess 决策表（13 行）见 A.8。

1. 能量曲线滑动平均（窗口 = smooth 参数，缺省 5 采样帧）；
2. 局部极小处切分（PME 三角形思路）+ 接触状态变化作为硬边界 + 连续静默段合并为 idle/hold；
3. 每段 label 分两层：
   - `label`（确定性）：idle / hold / contact-move / airborne / turn；
   - `guess`（工具的语义猜测，允许 Agent 基于数值推翻）：strike-punch / strike-kick / walk / run /
     backpedal / strafe-l/r / jump / spin / turn / crouch / gesture / recover / other；
     guess 依据写进 `features.basis`（如「峰值速度 2.1 身高/s 出现在右手」→ strike-punch）。

#### 6.6.2 强度档位（固定阈值）

主曲线 `energy`（身高/秒），全片标定 P50/P90/max；「激励程度」第二维度 = amplitude 变化 +
头/手末端速度占比。档位初值（待真实资产校准，常量放 core 并随输出回显；校准回路见 A.16）：

| 档位 | 平均能量（身高/秒） | 峰值能量 |
|---|---|---|
| static | < 0.05 | < 0.3 |
| low | < 0.15 | < 0.8 |
| medium | < 0.4 | < 1.6 |
| high | < 0.8 | < 3.0 |
| extreme | ≥ 0.8 | ≥ 3.0 |

#### 6.6.3 词汇表文件机制（guess 词表的「由 AI 根据记忆调整」落地方式）

工具保持确定性、不联网不学习；可调整的是**数据**：

- 内置基础 guess 词表（§6.6.1 的集合）+ 判定规则；
- 可选 `kinemesh-vocab.json`（发现顺序：`vocab` 参数显式指定 > 资产同目录 > 工作区 cwd > 仅内置）：
  扩展 guess 词条（战斗向：dodge / cast / hit-react / roll…），条目形如
  `{"term": "dodge", "when": {"airborne": false, "rootSpeedMin": 1.2, "headingTurnMin": 45}}`；
  `when` 支持 `anyOf` 数组（任一子条件组命中即可）；新增 `action` 字段——`label`（缺省，打词条）/
  `suppress`（命中则本段 guess 置 other）/ `demote`（命中则降级为 gesture）——项目可用它压制误报
  （如「walk 误报 turn」的特定资产）。顶层对象形式还可带 `"prefixes": ["myns:"]`（B.1 项目级
  骨骼名前缀扩展，analyze 的字典查表与 skeleton-report 共用）；
- **闭环**：用户使用反馈 → Agent 记忆（DSH 里是 OpenViking）→ Agent 在用户工程里维护该文件 →
  下次 analyze 确定性消费。summary 回显 `vocab: {source: "builtin"|"路径", entries: N}` 以便审计
  「这次的 guess 用了哪套词」。
- schema 随 SKILL.md / 设计文档给出，字段保持最小（条件只引用工具已产出的通道值）。

### 6.7 工具契约（三出口同名 `kinemesh_analyze`）

```
kinemesh_analyze(path, {
  clip?: string | "*",        // 缺省第一个有动画的 clip；"*" 批量分析全部
  out?: string,               // 缺省 <cwd>/.kinemeshtmp/run-<ts>-<pid>/
  range?: [number, number],   // [t0, t1] 秒，切片分析（帧号仍按全片口径，可直接喂 render）
  sampleFps?: number = 15,    // 1–60
  joints?: string[] | "auto",
  detail?: "summary" | "standard" | "full",
                              // summary=只出 summary.json；standard=+frames.csv
                              //   +segments+keyframes+trajectory；full=+全部关节曲线
  curvesFor?: string[],       // 指定关节加出曲线 CSV
  smooth?: number = 5,        // 能量平滑窗口（采样帧）
  loopMode?: "strict" | "pose-only" = "strict",
                              // bestLoopRange 口径（A.10）；verdict 恒为 strict
  normalize?: "height" | "none" = "height",
  vocab?: string,             // 词汇表文件路径（缺省按 §6.6.3 顺序发现）
  boneMap?: string            // 骨架映射文件路径（缺省按 B.5 顺序发现）
})
→ { ok:true, dir, files:[{name,bytes,what}], summaryDigest }
```

- `summaryDigest` 内联 summary 核心字段（分段表 + 全片统计 + loopCheck）+ **keyframeRender 配方**
  （≤8 个关键帧号 + 建议视角 front/side/three-quarter + 模式 skeleton/bones-overlay）——Agent
  原样传给 `kinemesh_render` 即可出识别用图，连「拍哪几帧、什么视角」都不用自己拼
  （能用工具生成的就用工具生成）；同时是「输出在临时目录」仍可用的兜底；
- `clip:"*"` 批量：summary 变 `clips[]` 数组、digest 逐 clip 内联；中间文件按 clip 分子目录
  `<dir>/<clip>/`；单 clip 输出结构不变（向后兼容）；
- `kinemesh_render` 帧号口径一致（frame = t×30），分析结果直接给 render 复现画面；
- CLI：`kinemesh.cjs analyze <file> [--clip …] [--detail full] [--curves-for RightForeArm]…`；
  MCP/DSH 同名同参（zod/JSON Schema 投影，与现有两工具同一套 core 入参）；
- 无动画资产调 analyze → 三段式自愈（同 render 无 clip 的口径）。

### 6.8 复用与边界

**复用**：viewer 的 RENDER_FPS 口径与 clip 选择；humanoid.ts 的关节惯例；units.ts 的身高与单位体检
（**H ≤ 0 / 缺失时** normalize 降级 raw 并把告警带进 summary——单位体检的「厘米未换算」告警**不**
触发降级：身高本身有效，归一后仍是正确的身高倍数，仅提示导出单位问题）；analyze-file.ts 的加载与自愈报错。

**非目标（v1 明确不做）**：
- 不做语义动作识别的深度模型（Unimotion 路线）——非确定性与本需求目标相反；
- 不做物理仿真、不做数据修复/滤波写回（FBXMotionToolkit 那些清洗能力）；
- 不做跨 clip 相似度检索（M8 候选）；
- 不做自适应变密度采样（M8 候选；精度需求先由 `range` 切片 + 高 `sampleFps` 覆盖）；
- 不修改源动画文件——分析只读，产物只有中间文件；
- 姿势九宫格 pose-labels（早期草稿内容）降级为后续候选——拍板后近似姿势的用途是
  循环/归位对比，九宫格语义描述不进 v1。

### 6.9 里程碑 M6 拆分

| 子阶段 | 内容 | 验收 |
|---|---|---|
| M6a | sampler + channels + frames.csv（含精确端点采样；moveDirBody / turnTotal 通道） | 合成动画（线性位移 / 正弦摆动 / 720° 自转）的数值逐项对答案 |
| M6b | segment + describe + summary.json + facts + trajectory JSON/SVG + 事件时间轴 + relativeLevel | 合成跳跃/出拳/倒退走/侧移动画的分段、guess 与事件帧符合构造预期 |
| M6c | 循环/归位检测：P(t)、loopCheck verdict、bestLoopRange（含 loopMode） | 四种已知答案资产 verdict 全对；root-motion 步伐循环 pose-only 找到循环体 |
| M6d | 三出口接线 + vocab 文件机制 + digest.keyframeRender 配方 + SKILL.md「分工与防幻觉规则」段（AI 推测须标注依据、不计算数值）+ 临时目录自愈 | 三出口契约一致；真实 FBX（Samba 等）端到端：analyze → 按配方 render 关键帧 → 读图识别 → 带依据叙述 |
| M6e | DSH 模型预览页（会话页签，详见 §6.10）：模型列表 + 预览工具 + 强度曲线时间轴（分段色带 + loopCheck/bestLoopRange 高亮）+ 「发送给 AI 分析」附带 digest；host 新增 `/kinemesh/analysis`、`/kinemesh/session-models` 路由 | 未用插件的会话无页签；曲线数值与中间文件一致；发送消息含 digest |
| M6f | 批量 clip（`clip:"*"`）+ `range` 切片 + 场景缓存 + morph-only 自愈 + A.16 校准回路（快照测试） | 一文件多 clip 全出 digest；重复分析命中缓存；morph-only 报错自愈；快照容差断言全绿 |

> 实际落地注记：M6a–M6f 均已交付并随 0.5.0 发布，实现细节以 `core/motion/` 与 `tests/kinemesh/` 为准。

测试延续现有策略：fixtures 合成「已知答案」的动画（构造循环=两端同姿、构造顿挫=末帧速度不为零、
构造位移=线性 root 轨迹），真实资产做兜底。版本 0.5.0。

### 6.10 DSH 交互（0.6.0 重构：左侧独立预览页 + `/kinemesh` 命令 + 会话页签）

> 0.6.0 按用户要求重构了三处入口（原「输入框左侧动析胶囊 + 浮层预览」已移除）：
> ① **左侧侧边栏独立预览页**（纯工具内置功能，不接 AI）；② **`/kinemesh` 命令**替代胶囊按钮；
> ③ **会话页签**保留「左列表 + 预览 + 发送给 AI 分析当前帧」。三者共用 `PreviewPane` 组件。

#### 6.10.1 三个入口

| 入口 | 机制 | 是否接 AI |
|---|---|---|
| 左侧侧边栏「动析预览」 | `sidebar.panellist` 图标 + `main` 槽主面板（aiworkflow 同款）；`PreviewPane allowSend={false}` | **否**（拖转/播放/曲线/拖入文件） |
| `/kinemesh` 命令 | Host `ctx.commands.register`；命令 + 拖入附件 + 要求 → 注入分析指令 | 是（由 Agent 调工具分析） |
| 会话「模型预览」页签 | `conversation.view`（条件注册：本会话用过 kinemesh） | 是（「发送给 AI 分析」当前帧） |

#### 6.10.2 `/kinemesh` 命令（Host 侧）

- 注册：`ctx.commands.register({ name:'kinemesh', description, input:{hint, attachments:true}, handler })`；
- `handler` 收到 `CommandInvocation = { commandId, agent, rawInput, attachments, signal }`：
  - `rawInput` 里可直接写路径（支持盘符/UNC/`~`/引号包裹含空格路径），非模型路径忽略；
  - `attachments` 是拖入输入框的文件（`FileBlock.attachment = {attachmentId,name,bytes}`，**无磁盘路径**）
    → 经 Host `fileUploads.resolve(agent, attachmentId)` 取内容，落 `%TEMP%/kinemesh-command-attachments/`
    下的临时文件（按扩展名保留），再把路径交给 Agent；
  - 解析不出内容/写盘失败 → 该附件计入「读不出」，最终无可用模型时返回 error + 用法提示
    （改用 `/kinemesh <路径>`）；
  - 成功：先记录会话模型表（页签左列表可见），再 `agent.followup()` 注入中文指令
    （含全部路径、用户要求、工具使用顺序、防幻觉约束）；Agent 离线 → error 附路径；
- 纯逻辑（扩展名判定 / 路径提取 / 消息组装 / 附件择优 / 内容落盘 / 模型头嗅探）在
  `src/command.ts`，`runCommand` 注入依赖便于单测（`tests/kinemesh/command.test.ts` 17 例）。

#### 6.10.3 会话页签注册（沿用 aiworkflow 运行图页签的已验证模式）

- 槽位 **`conversation.view`**：aiworkflow 已用它注册「运行图」会话页签（条件注册、随会话
  出现/消失），模式在本仓库内已验证，不新造机制；
- 注册条目 `{name:'conversation.view', id:'kinemesh-preview', order:20, label:「模型预览」}`；
- **出现条件**：本会话「用过 kinemesh」= 任一 kinemesh 工具（info/render/analyze/skeleton）以某路径
  执行成功、`/kinemesh` 命令解析成功、或在预览页里加载过模型——**Agent 工具直调经 exec.agent.id
  记入同一张会话表**（aiworkflow 同款口径；CLI / MCP 进程无会话概念不进表），HTTP 路由
  （model/info/analyze）处理成功也记入；
- 会话身份与数据：header utilities 槽捕获 sessionId（`dsh:<sessionId>`，aiworkflow 同款口径）；
  Host 维护 `sessionId → 有序去重路径表`（内存，按首次出现顺序，不持久化——会话级功能，
  Host 重启即清空、重新使用即恢复）；客户端在 sessionId 变化时同步注册/注销页签
  （aiworkflow `syncRunTab` 同款）+ 轻量拉取列表；
- 切到没用过的会话页签消失。

#### 6.10.4 页面布局

- **左侧模型列表**：host `GET /kinemesh/session-models?sessionId=` 返回路径 + 轻量信息
  （文件名 / 是否有动画 / clip 数 / 文件体积）；条目 = 文件名 + 动画徽标 + 完整路径 tooltip；
  默认选中**第一个**；底部「打开模型」输入路径可手动添加（与会话页签共用加载路由，成功即入列表）；
- **右侧预览工具**：共用组件 `PreviewPane`（独立页/页签共用，不新增
  第二套渲染路径）：
  - OrbitControls 全套：按住拖转视角、滚轮缩放、平移（viewer 模块已有）；
  - **拖入文件（0.5.3）**：把 `.fbx/.glb/.gltf/.obj` 拖到预览区即加载——桌面版经 preload 暴露的
    `window.__DSH_HOST_PATHS__.pathFor(file)`（Electron `webUtils.getPathForFile`）取真实绝对路径，
    走同一 `/kinemesh/model` 加载链路；纯浏览器环境拿不到路径（安全限制）→ 三段式提示改用粘贴路径。
    扩展名不符/多文件只取第一个，均给出中文提示；
  - **显示方式拆成两个控件（0.7.2，用户拍板）**：表面方式互斥下拉（`素模 solid` / `贴图 default` /
    `线框 wireframe`）+ **独立勾选框「叠加骨架」**——以前是一个 5 值下拉（default/solid/wireframe/
    skeleton/bones-overlay），无法表达「素模 + 骨架」这类组合。实现上 viewer 内部把状态拆成
    `surface`（default/solid/wireframe/none）+ `bonesVisible` 两个开关（`applyMode()` 一次应用），
    而对外契约仍是单一 `ViewMode`：`surfaceOfMode` / `bonesOfMode` 负责旧模式→拆解，
    `composeViewMode(表面, 骨架, 有无 mesh)` 负责合成回去（`getViewState()` / 记忆 / 发给 AI 都用合成值；
    无 mesh 时一律合成 `skeleton`，AI 侧不会误判「显示网格」）。截图 / CLI / MCP 的 `mode` 入参语义不变；
  - clip 选择、播放/暂停、逐帧/首末帧（0.7.0 播放条）；
  - 视角实时回读球坐标 ViewState（与 AI 截图同口径）；
  - 「发送给 AI 分析」（原浮层能力迁入页面，浮层保留入口）。
- **主题适配（0.5.3 修正）**：颜色**只用宿主真实存在的 `--dsw-alias-*` token**（`--dsw-alias-bg-overlay` /
  `-bg-layer-1..3` / `-label-primary|secondary|tertiary` / `-label-on-color` / `-border-l1` /
  `-brand-primary` / `-bg-mask-*`）；不使用不存在的 token 名（旧代码 `label-on-brand` 不存在，
  深色主题下主按钮回退白字叠亮底 → 视觉空白）。3D 舞台背景不再硬编码 `#23262b`。
  - **主按钮不要用「brand 填充 + on-color 文字」（0.7.6 再修）**：当前 DSH 深色主题里
    `--dsw-alias-brand-primary` 与 `--dsw-alias-label-on-color` **都是近白色**，两者叠加 = 白底白字，
    「发送给 AI 分析」按钮整个变成一块空白（用户截图复现）。改用 aiworkflow 已验证的配色套路：
    淡底 `bg-layer-2` + `brand-primary` 描边 + `label-primary` 文字（hover 换 `bg-layer-3`），
    任何主题都可读；回归对照见 `tmp` 下的 button-check 渲染（旧配方 = 白块，新配方文字清晰）。
    教训：brand-primary 在深色主题里是**浅色**（适合描边/文字/指示点），不适合当大面积填充色。
- **默认素模显示（0.6.6，用户拍板）**：预览默认走 `solid` 素模——常规 3D 工具（Maya/Blender/Unity）
  的标准显示方式，本项目的游戏资产普遍没有可用贴图，素模最利于看清姿态与动作。配套：
  - 素模材质：中性灰 `#d2d6db` Lambert + `DoubleSide`（游戏资产多为单面，头发/裙摆背面会破洞）；
  - **素模独立布光（0.6.7）**：素模用自己的一套 studio 布光（环境光 0.32 / 半球光 0.75 / 主光 2.2 /
    侧补 0.45 / 轮廓 0.38；`core/viewer/lighting.ts`）。**不能共用 0.6.4 的贴图布光**——那是为深色贴图
    资产压黑剪影调出来的过曝值（合计 8.4），素模是 Lambert：出射亮度 ≈ albedo × Σ(强度 × NdotL)，
    合计 >1 就整块截断成纯白色块（0.6.6 交验实测 **69% 模型像素 ≥250**）。量化口径（3D 工具观感）：
    素模像素 mean 172～179、p99 ≤214、≥250 占比 0%（调整后实测值）；合计 <3 会发灰发闷。
    质量守护：`lightRigFor(mode)` 纯函数 + `tests/kinemesh/viewer-lighting.test.ts` 钉住区间；
  - **裁剪面跟随观察距离（0.6.8）**：修「播放/拖动视角时模型表面碎成斑点」。原 near/far 写死
    `0.001 / 1e6`（跨 9 个数量级），而透视深度精度几乎只由 near 决定（24 位深度在距离 z 处的
    可分辨厚度 ≈ z²/(near·2²⁴)：z=220 时约 2.9 单位）。厘米级游戏资产里「皮肤 vs 短裤/护膝」两层
    只差 0.1～0.3 单位 → 互抢深度，表面碎成明暗抖动斑点，运动时最明显（实测模型像素里 1.4% 是孤立
    斑点）。改为按相机距离推导：near = 距离×0.02、far = 距离×20（`core/viewer/clip-planes.ts`，
    纯函数 + 单测），同位置可分辨厚度降到 <0.01 单位，实测斑点降到 0.6%（余量属模型自身层叠/接缝）；
    拖动/滚轮缩放时经 OrbitControls change 事件同步更新（拉近看细节不会退回低精度）。
  - **骨架线生命周期（0.6.9）**：`SkeletonHelper` 挂在 scene 上（不在 model 层级里），
    卸载模型时必须显式摘除 + 释放（`core/viewer/skeleton-helpers.ts`，纯对象操作 + 单测）。
    漏摘会让 `skeleton` / `bones-overlay` 模式「换一个 FBX 后残留旧骨架」——真实资产实测：
    换模型后画面多出 4740 个像素的旧骨架线段，修好后与「全新载入」对照图逐像素一致（diff = 0）。
  - **全局 XYZ 轴参考（0.8.1，用户拍板）**：地面保留 X/Z 两条长线（红/蓝，指示正负方向），
    另在视口**左下角加轴指示器（HUD gizmo）**——X 红 / Y 绿 / Z 蓝三根短轴 + X/Y/Z 字母标签。
    实现：独立 `axisScene` + 正交相机，每帧把主相机的朝向复制过来（位置 = 视线方向反推），
    在主场景渲染后用 `setViewport + setScissor + clearDepth` 叠在左下角固定像素框里
    （短边 × 18%，最少 64px），`sizeAttenuation` 关闭语义下标签始终可读、不被模型遮挡，
    且**截图管线同一条渲染路径**所以 AI 图片里也带朝向参考。所有立即出帧路径统一走
    `renderFrame()`（主场景 + 轴指示器），避免预览与截图构图不一致。
    退化场景：主相机与注视点重合时（`offset.lengthSq() === 0`）跳过指示器绘制。
    回归：`tests/kinemesh/axes.test.ts`（三轴端点/配色/标签位置/离线无 document 不出标签）。
  - **root motion 开关（0.9.0，用户拍板）**：预览工具栏加两个独立勾选框「锁定位移」「锁定旋转」，
    带位移的动作（冲刺/突进/360 转身斩）可以原地播放。实现 `core/viewer/root-motion.ts`（纯对象操作 + 单测）：
    - 载体判定：动画轨道命中的「最上层被动画节点」（`PropertyBinding.parseTrackName` +
      `findNode` 解析，剔除有被动画祖先的节点）——通常是 FBX 的顶层 `root` 节点 / Mixamo Hips /
      glTF 场根；真实资产 1012_tahlia attack_01 里就是 `root`（position/quaternion/scale 三条轨道）；
    - 参考姿态：载入后记录该节点的 position/quaternion（静止姿态）；每帧 `mixer.setTime()` 之后、
      渲染之前按开关写回——位移锁只还原 position、旋转锁只还原 quaternion、两个都锁 = 完全原地；
      **只动根节点，子关节动画不受影响**（否则会退化成 T-pose）；
    - 接入点：renderLoop / seekFrame / applyView / setRootMotionLock 都会套一遍（拖帧、播放、切视角一致）；
    - UI：模型无动画或无 root 载体时两个勾选框禁用（`viewer.rootMotionAvailable()`）；
      选择随面板记忆（`PaneMemory.rootLock`）恢复；
    - 实测（真实资产 + 固定机位逐帧量模型像素质心）：不锁时质心 X 漂移 502px（角色跑出画面），
      锁定位移后降至 20px（余量为姿势变化），锁定旋转对「root 无旋转轨道」的资产无副作用。
  - **角色根节点 XYZ 参考轴 + 开关（0.9.1，用户拍板）**：在**角色根节点**的世界位置画一小段
    X 红 / Y 绿 / Z 蓝三轴（轴端带字母），用来直视「根节点在哪、朝向如何」——和 0.8.1 左下角
    HUD 指示器的分工是：HUD 表示**全局**朝向（固定屏幕角落），根节点轴表示**角色根节点**的位置/朝向
    （跟着根节点走；开 root motion 时能直接看到位移，开启「锁定位移」后就定在原地）。
    实现 `core/viewer/root-axes.ts`（纯对象操作 + 单测）：单位长度的三轴线 + 字母 Sprite 组成 group，
    `update(node, worldLength)` 取节点 `getWorldPosition/getWorldQuaternion` 跟随、`scale = worldLength`；
    轴长 = 包围球半径 × 0.3（约身高的 1/6），线 `depthTest:false` 保证根节点在模型体内（骨盆/脚下）
    时也看得见。工具栏加勾选框「根节点轴」（默认开，可关；`viewer.setRootAxesVisible`，
    mount 选项 `rootAxes` 决定是否创建——**截图管线不创建**，避免杂线干扰 AI 读图）。
    选择随面板记忆（`PaneMemory.rootAxes`）恢复；无模型时自动隐藏。
  - **独立 mesh 文件输入（0.10.0；0.10.1 左侧层级列表）**：工具栏路径输入旁加「mesh 文件」输入框（占位提示；留空时载入后自动识别）；
    载入动画-only 文件后自动查 `GET /kinemesh/companions` 候选（内容扫描）、客户端逐个加载校验并绑定，
    绑定状态以 chip 显示「mesh 文件名 · 命中骨骼数/骨架骨骼数」，绑定提示（自动识别 / 未命中骨骼 / 根校正）
    进 info banner；mesh 路径进 `PaneMemory.mesh` 与「发送给 AI 分析」请求（契约见 §6.11）。
    独立预览页左侧新增**打开过的模型层级列表**（进程内存）：带 mesh+动画 = 独立条目，动作-only 文件挂在
    关联网格下（网格为根、动作作子节点）；点一行按「网格 + 动作」重载，× 删除记录（删网格连关联动作）。
  - 地面：20 段灰色网格 + X 轴偏红 / Z 轴偏蓝（3D 工具习惯）。**所有渲染模式都显示**
    （0.6.10：`default / solid / wireframe / skeleton / bones-overlay` 一视同仁——线框与骨架
    模式下同样需要地面/轴向参照；地面不参与包围盒，显示与否不影响机位适配）；
  - **辅助对象过滤**：Unity/Max 导出的 FBX 常带 Dummy、locator、IK 目标、线框 gizmo、相机/灯光辅助物，
    常规 3D 工具默认不显示；载入时按「对象类型（Line/Points/Sprite/Camera/Light）+ 命名（dummy|helper|
    locator|marker|gizmo|collider|probe|reference|placeholder）」隐藏，**骨骼与网格永不触碰**
    （`core/viewer/auxiliary.ts`，纯函数可测）；
  - 预览的下拉可随时切素模 / 贴图 / 线框并叠加骨架线；**截图管线自 0.8.0 起同样「省略 mode 就按模型
    自动选」**（与预览同一套 `auto-mode.ts` 规则，见 §3.8），需要固定模式时显式传 `mode:"solid"` 等。
- **播放条与轨道（0.7.0，用户拍板改版）**：
  - **3D 舞台铺满页面**：舞台不再写死 `min(58vh,540px)`（只占半屏），改 `flex:1 1 min(46vh,420px)`
    ——容器高度确定时长满剩余空间；万一父容器高度是 auto（flex 链断），至少 420px 不回退成一条；
  - **播放条 = 5 个纯图标按钮**，整条放在**轨道条上方**、居中：回到第一帧 / 前一帧 / 播放·暂停 /
    下一帧 / 跳到最后一帧（手绘 SVG，不引图标库；`title`/`aria-label` 为无障碍名；首末帧与播放
    按钮按当前帧禁用）。逐帧与首尾跳转**播放中先暂停**（「检查某一帧」语义）；
  - **原播放按钮 + 帧滑条（`.kinemesh-controls`）删除**：拖动 scrub 与帧号 `f{current} / f{total}`
    合并进轨道条——轨道头行左侧是说明文案、右侧是帧号徽标，轨道本体（SVG）点击/拖动定位帧；
  - 轨道/刻度在**没有强度曲线**时也照常显示（分析未返回 / 分析失败 / 静态片段）：0.7.0 起轨道是
    唯一定位入口，不能因为缺曲线就消失（此时提示文案切换为 `timeline.hintNoCurve`）；
  - 帧号口径统一走 `clampFrame` / `stepFrame` 纯函数（`tests/kinemesh/client-preview.test.ts` 直测：
    首末帧静止不绕回、非法入参归 0、`duration×fps` 浮点误差不产生半帧）。
- **轨道三档刻度（0.7.4，用户拍板）**：`timelineTicks(maxFrame)` 纯函数（单测覆盖）产出
  `minor | medium | major` 三级——**每帧**一根细刻度（1/4 高）、**每 5 帧**中刻度（1/2 高）、
  标签帧（`frameTicks` 自适应步长，≤9 个）满高长刻度。极长片段（如 1800 帧）逐帧画会糊成一条边，
  细刻度步长按 `TICK_MIN_SPACING`（视图 2 单位）自适应放大、中刻度随之 ×5；短片段就是逐帧。
  刻度文字仍在 HTML 层（SVG 横向拉伸会把文字压扁）。
- **播放速度滑块（0.7.4）**：播放条右侧「速度 [拖动条] 1.0×」，范围 0.1×～2×（viewer 侧
  `setPlaybackRate` 兜底夹到 0.05～4，`clampPlaybackRate` 纯函数单测）。只影响**播放推进**
  （`frame += Δt × 30fps × rate`），seek 与截图永远按真实帧号。实测 900ms：1× → 28 帧、
  2× → 48 帧、0.2× → 4 帧。
- **帧号显示恒为整数（0.7.4）**：播放时内部帧号是连续小数（平滑推进），轨道头部/读数一律
  `Math.round` 后再显示——修 0.7.3 之前出现过的 `f9.115996421575549 / f55`。
- **暂停后仍可跳转（0.7.5，真根因）**：修「暂停之后点轨道条/播放条跳转，帧号与播放头在动、
  但 3D 画面不动」。根因是 three 的 `AnimationAction.paused = true` 会把 `_effectiveTimeScale`
  归零，于是 `AnimationMixer.setTime(t)` 内部 `deltaTime *= scale` 变成 0，action 时间停在 setTime
  刚重置的 0 上 → 姿势永远回到**第 0 帧**（所以第一次跳转看着"动了"，之后每帧画面完全一样），
  而再次播放会 `reset().play()` 解开 paused 又正常——这就是"好了又坏"的由来。
  修法：`pauseInternal()` **只清 `playing` 标志，不设 `action.paused`**（渲染循环本来就用 `playing`
  门控推进）；`seekFrame()` 里再兜一层 `if (action.paused) action.paused = false` 才 `mixer.setTime`。
  回归测试：`tests/kinemesh/viewer-pause-scrub.test.ts` 直接钉住 three 的这个行为；
  端到端 harness（真实 client.js + 真 FBX）实测暂停后连续跳转：修前 3 次跳转 diff 全为 0，
  修后 56344 / 54086 / 17259 / 37120 像素变化。
- **渲染循环健壮性（0.7.4）**：修「点轨道条/播放条跳转不刷新显示」。three 的
  `setAnimationLoop` 在回调抛错后**不会排下一帧**，循环一死画面永停、交互区还在动——正是这个症状。
  ① `renderLoop` 整体 try/catch（异常只记一次，循环继续）；② 每次交互（play / seek / setDisplay /
  setMode / applyView）都 `ensureRenderLoop()` 重新挂上循环，上下文丢失后也能自愈；
  ③ `seekFrame` 改「立即 render 一帧 + 250ms 兜底」，不再依赖循环节奏；④ 监听
  `webglcontextlost` / `webglcontextrestored`（同屏多个预览画布时 Chromium 会回收上下文），
  恢复后重挂循环并补一帧。
- **载入自动选渲染模式（0.7.1，用户拍板）**：`core/viewer/auto-mode.ts`（纯判定 + 单测），
  载入后由 `viewer.modeSuggestion()` 给出三档建议：
  - **没有 mesh**（纯骨架 / 只有空物体）→ `skeleton`——网格模式下一片空白，骨架才看得出东西；
  - **有 mesh 但没有可用贴图** → `solid`——贴图模式只会得到灰白/黑块；
  - **有可用贴图** → `default`（贴图模式），材质信息是真的，不必盖成素模。
  - 「可用贴图」口径 = `map` 存在且 `map.image` 非空（**解码成功**）。FBX 常见的 TGA 在浏览器里
    解不出来（image 为 null，0.6.4 黑剪影同源），真实资产 1005_tacy 的 4 张贴图全部属于这一类 →
    实测 4 个 attack 片段都判为 `solid`；顶点色**不算**可用贴图（游戏资产顶点色多为暗底，
    贴图模式仍是深色剪影，素模更能看清几何）。
  - **异步贴图复审**：贴图解码是异步的，载入瞬间 image 可能还是空——面板在 1.6s 后用
    `modeSuggestion()` 现算一次，仅当本次为自动选择、用户此后没手动切过模式时才纠正；
  - **优先级**：同一路径的「上次手动选择」（`readPaneMemory`）> 自动建议；用户手动切换后
    `changeMode` 打上手动标记，本次载入不再被自动纠正。读数区用 chip 显示自动理由
    （`自动：骨架（模型没有 mesh）` / `自动：素模（没有可用贴图）` / `自动：贴图`）。

#### 6.10.3 动画时间轴 + 强度曲线（M6e 核心）

- 仅动画资产显示时间轴；可拖动 scrub（`seekFrame` 渲染完该帧才更新画面——viewer 已有确定性 seek）；
- **进度条上方叠加强度（energy）曲线**：host `GET /kinemesh/analysis?path=&clip=`（M6 core
  内存返回 energy 序列 + 分段 + loopCheck，不落盘）→ 归一化折线；播放头竖线随播放移动；
  点击/拖动曲线任意位置 = seek 到对应帧；
- 曲线下沿画**分段色带**（label 色 + guess tooltip）+ **loopCheck / bestLoopRange 区间高亮**
  （拍板 #6 的「面板叠加」落在这里）；
- 时间轴组件同样共用：浮层预览里也顺手获得曲线显示（同一组件，零额外成本）。

#### 6.10.4 边界

- 列表按 sessionId 隔离；Agent 工具直调与页面/路由加载都记入同一张会话表（§6.10.1）；
- 页签文案与页面文本走 locale 服务（zh/en locale 文件已有）；
- 不做跨会话历史列表（会话日志才是事实源；要做也是后续从会话日志回放，非 v1）。

### 6.11 独立 mesh 文件绑定（0.10.0，用户需求）

**需求**：游戏资产常把动作单独导出——FBX 只有骨架 + 动画（`meshes: []`，实测
`4006_tankclaw_ice/hit/decide_spine_shake.fbx` 只有 5 根脊柱骨骼），角色网格在另一个文件
（`4006_tankclaw_ice/basic/4006_tankclaw_ice_skin.fbx`，88 骨 + 2 个蒙皮网格）。这类文件直接
`render` 只能出骨架图，AI 做动作/模型视觉分析时缺网格。用户要求：**可以提供一个独立 mesh 文件用于
预览和截图分析，工具自动识别并绑定**。

**契约**（三出口同名同参）：

- `kinemesh_render` / `kinemesh_info` 新增可选 `mesh` 参数（CLI `--mesh`）；`path` 是动画文件、
  `mesh` 是网格文件（角色/道具的蒙皮网格）。`kinemesh_analyze` / `kinemesh_skeleton` 不接 `mesh`——
  动作分析只吃动画通道、骨架报告只看骨架，网格不参与数值。
- **角色自动识别**（`core/bind/roles.ts`，纯逻辑）：网格优先 mesh 参数文件，其次 `path` 自带；
  动画优先 `path`，其次 mesh 参数文件（两个参数传反也能纠正）；两侧都缺网格/动画 → 三段式。
  网格与动画同源（同一文件）→ 不绑定、警告说明哪一侧没用上。
- **骨骼名绑定 + 世界姿态对齐烘焙（0.10.4 定型，`core/bind/remap.ts`，纯 three 对象操作）**：
  逐轨道用 `THREE.PropertyBinding.parseTrackName` 取 nodeName → 精确名 > 归一化名（去 `mixamorig:` /
  `Armature|` / `Root|` 等命名空间、空格转下划线、小写，另收 `PropertyBinding` 清洗形）。
  命中后**不再直接搬局部值**：用动画文件自己的骨架 `AnimationMixer` 逐采样时刻（轨道关键时间并集）求值，
  把**世界矩阵**按 mesh 骨架层级反解成本地 TRS 写成新轨道（只覆盖该片段真正驱动的节点，其余保持 mesh rest）。
  两个文件都被 loader 统一到 Y-up 世界，所以直接复制动画骨架世界姿态即可（再乘场景根矩阵会二次旋转——
  Sword 资产实测会躺倒）。这样 bind pose / Z-up-Y-up 混用时预览姿态与动画文件自身一致、脚落地；
  未命中节点丢弃并记入报告；0 命中 → `KinemeshError` 三段式。**部分骨骼动画仍可用**（如 5 根脊柱的
  受击附加动画：只烘焙这 5 根，其余保持 rest），但自动配对不会选它（见覆盖率下限）。
- **同资产网格发现（0.10.1 改为内容匹配、0.10.2 连枚举都按内容，`core/bind/scan.ts`）**：动作文件附近的本目录 / 上一级 /
  上两级，各向下 3 层、最多 400 个模型文件。先用**便宜的内容探测**（不解析场景）筛出「真的有网格」的
  文件：ASCII FBX 看 `Geometry:` 段、二进制 FBX 看节点名 `Geometry`、glTF/GLB 看 `meshes`/`skins`；
  同时 ASCII FBX 与 glTF 能直接抽骨骼名（`Model: …, "LimbNode"` / `skins[].joints`），二进制 FBX 只对
  排序靠前的少量候选解析一次补骨骼名。候选按**骨骼名覆盖率**（命中动作骨骼数 / 网格骨骼数）排序，
  同分看文件体积（小者优先，LOD 天然胜出）与目录距离；**完全不看文件名/目录名**（用户明确要求：
  命名仅供参考、不能依赖）。**覆盖率 < 35% 不参与自动配对**（0.10.4：跨角色的 5 骨附加动画在任意双足
  角色上都能「命中」，自动绑定会套错人；显式 `mesh` 参数不受限）。进程内按「路径 + mtime + 大小」缓存探测结果。
  - 工具侧（`core/bind/auto.ts`）：仅当 `path` 文件确实没有网格时触发，取覆盖率最高者绑定并在
    `warnings` 说明「已按文件内容自动识别同资产的网格文件「…」（骨骼命中 71/80（89%））」+ 其它候选；
    无候选则退回骨架并提示用 `mesh` 显式指定。
  - 预览面板：`GET /kinemesh/companions?path=…`（host 侧加载动作场景取骨架节点名 → 内容扫描）拿候选，
    客户端逐个加载校验并绑定。
- **全拖拽自动配对（0.10.3）**：预览面板的网格配对不要求手填路径——① Host 新版：拖入动画文件时 `/kinemesh/companions` 内容扫描附近网格；② Host 旧版（该路由 404）：用**本次进程里打开过的网格**自动配对（拖过 mesh 即可）；③ 拖入顺序反过来（先动画后网格）时，网格加载后对列表里仍孤立的动画记录做一次补配（内容绑定成功才挂上）。旧 Host 时 banner 明确提示「重启 DSH 后自动扫描可用」。
- **格式/配对判定全部按内容（0.10.2，不同项目命名约束不同）**：`detectFormat` 先按 magic/结构特征
  （FBX magic/ASCII 头、GLB magic、glTF JSON、OBJ 关键字）判格式，**扩展名只在内容判不出来时兜底提示**；
  同资产扫描的**候选枚举**也改为「读文件头 4KB → 内容探测 → 命中才全量读」，不再按扩展名筛文件；
  `/kinemesh` 命令的附件与手写路径、预览页拖入文件同样按内容判定是否模型（非模型/读不到列入忽略说明）。
  多个网格候选骨骼覆盖率并列时，`warnings` 列出候选并说明「已按体积从小到大选」，各项目对 LOD/皮肤
  变体的取舍不同，用 `mesh` 参数显式指定即可。
- **世界姿态对齐烘焙（0.10.4，真实资产 Haylee Bow/Sword 暴露）**：同一套 rig 分两次导出时 bind pose /
  up-axis 可能不同。实测：`F_R0201_Bow_Attack01-1.FBX` 是 Z-up、`F_R0201_Sword_Attack01.FBX` 是 Y-up，
  而 mesh 是 Z-up；只搬局部值会让 Sword 躺倒/肢体错位，只校正根骨骼会让 Bow 整体被多转一个角度、
  脚离地约 3cm。`bindClipsToModel(mesh, clips, sourceRoot)` 现在：用动画骨架求值 → 采样时刻取世界矩阵 →
  按 mesh 层级 `local = parentWorld⁻¹ · animWorld` 反解（只处理命中且被片段驱动的节点）→ 写成 position/
  quaternion/scale 轨道。烘焙后实测 Bow/Sword 逐帧**脚底最低点 ≈ 0.000**（不再悬空），
  `report.retargetedBones` / facts 记录烘焙骨骼数（通常 = 片段驱动骨骼数）。
- **合成与三出口共用**（`core/bind/bundle.ts`，浏览器安全）：`loadSceneFromData` / `sceneFacts` /
  `bindScenes`（= `planCompanion` + `applyPlan`）/ `loadSceneWithCompanion`。截图页桥
  `load(b64, name, companionB64?, companionName?)` 在页面内加载两个文件并绑定，保证「预览 = 截图」；
  `RenderResult` 增 `binding`（plan + facts），绑定 warnings 透传到结果；无网格且无 companion 时
  给出 mesh 参数提示。
- **info 体检**（`core/bind/inspect.ts`）：加载两个场景（path+mtime 缓存）→ 角色识别 → 试算绑定，
  返回 `companion`（网格文件 InfoReport）+ `binding`（plan / report 命中统计 / facts / warnings /
  error）。绑定失败**不致命**：info 仍 `ok:true`，`binding.error` 给三段式；不带 `mesh` 且无网格时
  附同资产候选（内容扫描，按骨骼覆盖率排序）。
- **预览面板**（§6.10 那条 bullet）：工具栏「mesh 文件」输入框（留空自动识别）+ 绑定 chip + 绑定提示
  banner；`mesh` 进 `PaneMemory` 与 `POST /kinemesh/analyze`，消息里写明绑定网格文件并指示 Agent 给
  `kinemesh_render` 传该 `mesh` 参数。**独立预览页左侧层级列表（0.10.1）**：进程内存记录打开过的模型，
  带 mesh+动画的文件为独立条目，动作-only 文件挂在关联网格下（网格根 / 动作子节点、缩进 + 徽标 + 子数），
  可逐条删除（删网格连同关联动作）；点一行按「网格 + 动作」重新加载（`loadRequest.mesh`）。
- **输出统计口径**：`matchedNodes`（命中 mesh 命名节点数）与 `matchedBones`（其中骨骼数）分开统计——
  动画也可能驱动 mesh 上的非骨骼节点（武器网格等）；facts 用「动画驱动 mesh 骨架的
  matchedBones/meshBones 根骨骼；轨道命中 matchedTracks/totalTracks」。
- **测试（0.10.4 更新）**：`tests/kinemesh/companion.test.ts`（轨道重绑定/命名空间/部分骨骼/完全不匹配、
  世界姿态对齐烘焙后 mesh 骨骼世界姿态 = 动画骨架世界姿态、rest 一致时 correctedRoots 为空、
  角色识别与三段式、内容扫描按覆盖率排序/排除无网格与不匹配者、info `mesh` 体检、预览 chip 文案）；
  `opened-assets.test.ts`（层级列表记录/网格根+动作子节点/删除子树）；
  `screenshot.int.test.ts` 新增「绑定渲染 / 参数传反 / 骨骼完全对不上」三例；`host-routes.test.ts` 加
  companions 路由（内容扫描）与 analyze 带 mesh 的消息；`cli.test.ts` 加 `info --mesh` / `render --mesh`；
  fixtures 新增 mesh-only 与 animation-only GLB。真实资产实测（0.10.4）：
  - Haylee Sword（Y-up 动作）+ Basics lod skin（Z-up mesh）：内容扫描选中 lod mesh（71/80 = 89%），
    世界姿态烘焙后攻击姿态直立、脚底最低点 ≈ 0.000，轨道 213/213；
  - Haylee Bow（Z-up 动作）+ 同一 mesh：烘焙后姿势与动画文件一致（不再被多转、不再悬空），逐帧 minY ≈ 0.000；
  - tankclaw 5 骨脊柱附加动画：覆盖率 6% < 35% → 不再自动套到别的角色（退回骨架，提示显式 `mesh`）；
  - tacy / 同 up-axis 全骨架动画：烘焙结果与动画自身姿态一致（等价于直接搬局部值）。

## 7. M7 骨架识别与映射（已实施）
需求（用户拍板）：AI 要能识别骨架类型（约定）与身体部件（头/胳膊/手/腿/脚）；命名不标准的 rig，
用「**截图带骨骼名字让 AI 识别**」定案。

### 7.1 分层策略（工具只查表，AI 是唯一兜底）

| 层 | 谁做 | 手段 | 置信 |
|---|---|---|---|
| L1 字典 | **工具** | 前缀剥离 + 分词 + 同义词表（Mixamo / 3ds Max Biped / UE Mannequin / VRM / Rigify / 常见英文 / 少量拼音）——**纯数据查表，无启发式** | high（标准约定即全对） |
| L2 语义 | **AI** | 读 `skeleton-report.json`（名称 / 层级 / rest 世界坐标——工具提供的原料）直接做部位对应 | 定案 |
| L3 视觉 | **AI** | 命名不透明（Bone01…）时读**骨骼名标注截图** | 定案 |

- **为什么保留 L1**：字典是数据不是算法（约 50 行查表代码），Mixamo/Biped/UE/VRM 这类标准 rig
  **零 AI 成本直达**——不出截图、不读图、不写映射；字典表开放 vocab 同款文件扩充。
- **为什么砍掉模糊匹配与几何启发**（早期草稿的 L2/L3）：半可靠中间层代码面大、结果还常要 AI 复核；
  几何信息并不丢——report 里的 restWorldPos / parent 就是给 AI 的原料，AI 读数推断是它的强项
  （数值由工具提供，AI 只做语义对应，不违反「AI 不计算」原则）。
- **识别出问题就回退给 AI**（用户拍板口径）：L1 覆盖不满 CORE15 → digest 给两级指引 →
  AI 先读 report（多数半可读命名到此为止）→ 仍不透明再出标注截图 → 写 `kinemesh-bones.json`
  → 工具确定性消费。
- **非人形 rig**（四足 / 带翼 / 多足 / 蛇形 / 机械）：人体命名字典天然不适用，**直接进 AI 两级
  流程**判定 archetype 与肢链（§7.2）。

### 7.2 非人形骨架（archetype 是一等公民）

不是所有 rig 都能按人体部件命名——四足、带翼、多足、蛇形、机械。口径：

- **骨架类型（archetype）是 AI 的语义判断**：字典只服务 humanoid 约定（B.2 表）；非人形命名
  （Leg_FL / Wing_L / Animal_01…）字典覆盖不到 → 直接走 AI 两级流程；report 附**结构统计**
  `{limbChains, groundTips, symmetryPairs, maxChainDepth}`（工具只数数不判定，给 AI 当原料）。
- **映射文件 schema v2**（B.5）：`archetype: humanoid | quadruped | winged | multiped | chain |
  custom` + `root / head / spine[] / limbs[]`（每条肢链 role: leg|arm|wing|tail、bones 有序、
  tip 指端）；humanoid 保持 `bones` 简写（CORE15）不变。
- **M6 通道全部有泛化定义**（B.7）：能量权重按链位置；**接触检测泛化为「贴地肢链 tip」**
  （rest 高度贴地的 limb 就是腿——四足 4、鸟 2、蜘蛛 8，人形 foot/toe 是特例）；heading 回退序
  对称肢+脊柱 → root→head → 根骨骼朝向。
- **档位阈值口径**（诚实声明）：强度/循环阈值按人形运动校准，`archetype ≠ humanoid` 时 summary
  固定加 warning「强度档位按人形校准，非人形仅作横向参考」——不假装跨物种可比。
- chain（蛇形）：无肢链 → contact 置 null + warning（v1 不做蛇形贴地），其余通道正常。

### 7.3 交付物

- **新工具 `kinemesh_skeleton(path, {shots?, boneMap?, out?})`**（三出口同名，第 4 个工具；
  视角/分批按 B.4 固化：shots:auto/all 直接渲染标注截图，renderRecipe 回显配方供降级手跑）：
  - `skeleton-report.json`：每骨 `{name, parent, depth, children, restWorldPos, partGuess,
    confidence, source: "dict"|null}` + 约定识别 `{convention, matched/total}` +
    结构统计 `{limbChains, groundTips, symmetryPairs, maxChainDepth}` +
    映射文件 schema 尾注；
  - **标注截图按需出**：`shots = "auto"`（缺省，仅当 CORE15 有缺口才渲染）| `"none"`（只出
    report）| `"all"`（强制全量）；skeleton 模式 + 骨骼名文字标签（stride 分批防叠，规格 B.4），
    front + side 两视角，PNG 命名 `labels-<view>-<batch>.png`；
  - digest：convention、unmapped 清单、report/截图路径 + **两级指引 fact**
    （先读 report 推断；不透明再 `shots:"all"` 出图 → 写映射文件 → 重跑）。
- **`kinemesh-bones.json`（映射文件）**：AI/人工写，schema 与校验见 B.5；
  `boneMap` 走 B.5 发现顺序（参数 > 资产同目录 > cwd），info 不单设参数。
- `info` 升级：`bones.convention` + `bones.mapped`（`humanoidLike` 保留 M1 口径 =
  matchedCategories ≥ 4；提示位不驱动工具决策，重定义延后候选）。

### 7.4 与 M6 的关系

- 工具内 joints 解析顺序：**映射文件 > L1 字典 > motion-top15 回退**（回退时 summary 注明并
  附「AI 补映射」指引）；AI 兜底是 **Agent 侧流程**（读 report/图 → 写映射文件），不进工具运行时；
  非人形映射到位后走 **B.7 泛化通道**（不再是 top15 回退）；
- 映射文件是会话外可复用的**工程资产**（放资产同目录），与 vocab 文件同一「AI 维护数据、
  工具确定性消费」模式。

### 7.5 里程碑 M7（版本 0.5.0（与 M6 同版发布））

| 子阶段 | 内容 | 验收 |
|---|---|---|
| M7a | `core/analyze/bone-map.ts`（B.1–B.3：归一 / 同义词 / 约定识别）+ skeleton-report + info 集成 | 合成 Mixamo / Biped / UE / VRM 四套命名 rig：convention 与字典映射全对 |
| M7b | 标注截图渲染（B.4，按需出图）+ `kinemesh_skeleton` 三出口 | 60 骨 rig 标签不互叠（stride 批次生效）；`shots:"auto"` 有缺口才出图 |
| M7c | `kinemesh-bones.json` 消费（B.5）+ analyze joints 走映射链 + SKILL 两级兜底工作流段 | 乱命名合成 rig（Bone01…）→ AI 读 report+图写映射 → analyze 全通道产出（无 top15 回退） |
| M7d | 非人形通道泛化（B.7）+ archetype 映射消费 | 四足合成 rig：4 肢 tip 接触/腾空判定正确、heading=root→head、链位权重生效；蛇形 rig contact=null+warning |

> 实际落地注记（M7 随 0.5.0 与 M6 同版发布；**M7a–M7d 全部交付**，实现细节以 `core/analyze/bone-map.ts`、
> `core/analyze/skeleton-report.ts`、`core/analyze/label-batches.ts`、`core/motion/sample.ts`（archetype 解析）
> 与 `tests/kinemesh/` 为准）。**B.4 骨骼名标注截图已实装**（`kinemesh_render` 的 `boneLabels` / CLI
> `--bone-labels` 画文字精灵 + `kinemesh_skeleton` shots:auto/all 直接渲染 `labels-<view>-<两位批次>.png`
> 进 run 目录与 digest.shots；批次划分纯函数在 `core/analyze/label-batches.ts`，渲染复用 render 截图管线）。
> **B.7 泛化通道已实装**（M7d：非 humanoid 映射 → `archetype:<type>` 关节集（AS 构造 + 链位权重，
> 肢链 >8 按 tip 位移方差 Top-8）；接触泛化为贴地肢链 tip（新增 contactTags 列，支撑态补
> multi-support / n/a）；heading 回退序含 root→head；蛇形无贴地肢链 → contact 不输出 + warning；
> 非人形阈值口径 warning 由 sample 层产出、三出口一致）。

## 8. M6/M7 拍板决策记录（2026-11-18 用户拍板，14 条）

1. **近似 pos 的用途**：循环 / 归位检测（算法见 §6.5）；姿势语义描述（九宫格）降级后续候选。
2. **label 语言**：英文 label + 中文 notes/facts。
3. **强度阈值**：固定内置，不开放参数；随输出回显可审计。
4. **guess 词表**：不写死——词汇表文件机制（§6.6.3），由 Agent 根据记忆在用户工程里维护。
5. **trajectory SVG**：进 v1（手写轻量 SVG，无栅格化依赖）。
6. **预览面板叠加**：进 v1（M6e，落在预览页时间轴）。
7. **输出目录**：缺省 <cwd>/.kinemeshtmp/run-<时间戳>-<pid>/（与 render 一致）；summaryDigest + 自愈指引兜底可读性。
8. **facts 语言与粒度**：中文；每段一句 + loopCheck 一句。
9. **AI 分工口径**：AI 不自行计算数值，基于工具产出的一组数据做**推测**；
   能用工具生成的就用工具生成；关键帧由 AI 调 `kinemesh_render` 出图做视觉识别，
   「拍哪几帧/什么视角」的配方由 digest 下发。
10. **DSH 模型预览页**：当前会话用过 kinemesh 即在「对话」页签旁出现「模型预览」页——左侧会话内
    模型列表（默认选第一个）、右侧预览工具（拖转视角等常规操作）；动画资产加可拖进度条并叠加
    显示强度（energy）曲线。
11. **骨架识别与映射**：非标准命名 rig 识别身体部件——自动映射 + **骨骼名标注截图交 AI 读图定案**，
    结论写入 `kinemesh-bones.json` 由工具确定性消费（新工具 `kinemesh_skeleton`，M7a–c）。
12. **骨架识别分工简化**：工具只做**字典查表**（前缀剥离 + 同义词表，纯数据）与约定识别；
    模糊匹配与几何启发**砍掉**——识别缺口一律回退 AI（先读 skeleton-report 数据，不透明命名再要
    标注截图），结论仍写 `kinemesh-bones.json` 确定性消费；截图按需出。
13. **非人形骨架**：archetype（humanoid / quadruped / winged / multiped / chain / custom）由 AI
    语义判定；字典仅服务 humanoid；映射文件 schema v2（root / head / spine / limbs）；M6 通道全部
    有泛化定义（贴地肢链 = 接触检测、链位权重、heading 回退序）；非人形时强度档位附「按人形校准」
    口径 warning。
14. **补充与灵活性盘点**：补 turnTotal（整圈旋转）/ moveDirBody（倒退、侧移）/ 事件时间轴 /
    腾空统计 / morph-only 自愈 / 批量 clip / range 切片 / 场景缓存 / A.16 校准回路；
    灵活性走 relativeLevel 相对档位、loopMode、vocab anyOf+action——**仍不开放阈值与敏感度参数**
    （守 #3 固定口径）。

## 9. 遗留实现细节（不阻塞实施，实现时定）

- `kinemesh-vocab.json` 的条件字段最终 schema（只约束到「引用已产出通道值」这一层）；
- 同义词表/前缀表的初始覆盖面（拼音、国产引擎命名习惯）——随资产用 vocab 同款文件扩充；
- 强度曲线时间轴是否提供缩放 / amplitude 曲线切换（v1 先不做，交互口径见 §6.10.3）；
- 会话模型表的拉取节奏（sessionId 变化时 + 何种轻量轮询）。

## 附录 A 算法规格（M6 实现唯一依据）

> 目标：下游开发**不再自行设计**——公式、常数、步骤、边界全部在此。每块标注依据：
> 「依据:外部」= 有外部先例（附链接）；「依据:自定」= 项目自定启发式（常数可校准，结构不可改）。
> 全部常数集中在 A.15 一张表，实现放 `core/motion/constants.ts` 单一来源，并随输出回显。

### A.0 记号与单位

- `H` = 模型身高（bounds.heightMeters；单位体检告警时照用，warning 透传进 summary）。
  所有长度除以 H、速度单位为 H/s（身高/秒），跨资产可比。
- `f_s` = sampleFps（缺省 15）；`Δt = 1/f_s`；`N = ceil(duration·f_s)`；
  采样网格 `t_k = kΔt`（k = 0..N−1）；另对 `t = duration` 精确评估一次（记虚拟点 k=N，
  仅用于 seam 分量与「端点」关键帧）。
- 帧号口径 `frame(t) = round(t × 30)`（RENDER_FPS，与 kinemesh_render 一致）。
- `p_j(k) ∈ R³` = 关节 j 在 t_k 的世界坐标（A.1）。
- **关节集 J15**（人形，复用 humanoid.ts 命名惯例；匹配不到的从集合剔除并在
  `summary.jointBasis.declaredJoints` 说明）：`hips, spine, head, L/R UpperArm, LowerArm, Hand,
  UpperLeg, LowerLeg, Foot`。非人形回退：骨架中「世界位移方差 Top-15」骨骼，
  `summary.jointBasis = "motion-top15"`；M7 映射落地后非人形优先走 **archetype 映射 + B.7 泛化
  通道**，无映射文件时才回退 top15。

### A.1 headless 采样（sample.ts）

1. 场景来自 §6.2 的进程内缓存（`path+mtime` 键）；**采样前快照全部骨骼 rest 姿态
   （local pos/quat/scale），采样结束必须恢复**——缓存实例被 analyze / render / 面板复用，
   残留姿态会污染后续调用（快照恢复是必经步骤，不是兜底）。
2. 每个 clip 预建：对每条 track 建 `binding = new PropertyBinding(sceneRoot, track.name)` 与
   `interp = track.createInterpolant()`。
3. 对每个 t_k：逐 track `interp.evaluate(t_k)` → `binding.setValue(target, values)`；
   全部 track 设完后 `sceneRoot.updateMatrixWorld(true)`；读 J15 世界坐标存 `p_j(k)`。
4. 一次 analyze 只处理一个 clip；无动画/clip 缺失 → KinemeshError 三段式（同 render 口径）。

依据:外部——three.js 公开 API（PropertyBinding/createInterpolant 是动画系统基础件，
viewer 的 setTime 走同一求值链路）。

### A.2 导数与平滑（channels.ts）

- 速度（中央差分，内部 k=1..N−2）：`v_j(k) = (p_j(k+1) − p_j(k−1)) / (2Δt)`；
  端点单侧：`v_j(0) = (p_j(1) − p_j(0)) / Δt`，`v_j(N−1)` 同理。位置先 /H 再差分（与先差分再 /H
  等价，实现固定前者）。
- 加速度同法二阶差分，仅内部使用，CSV 默认不输出。
- 居中滑动平均 `smooth(x, m)`（m=2，窗宽 5）：
  `x̂(k) = mean(x(k−m .. k+m) ∩ [0, N−1])`——端点用截断窗口（除以实际元素数）。

依据:外部——标准数值差分；窗宽 = smooth 参数（缺省 5 → m=2）。

### A.3 能量与幅度

- **权重表（J15）**：hips 0.2，spine 0.3，head 1.0，UpperArm 0.7，LowerArm 0.9，Hand 1.2，
  UpperLeg 0.5，LowerLeg 0.7，Foot 1.0（左右同权）。Σw = 11.5。
- **能量** `E(k) = Σ_j w_j·|v_j(k)| / Σ_j w_j`——语义 = **加权平均关节线速度（H/s）**，
  §6.6.2 档位表直接作用于此值。
- **幅度** `A(k) = mean_{末端∈{L/R Hand, L/R Foot, head}} dist(末端, 躯干轴) / H`；
  躯干轴 = 过 hips、head 世界坐标的直线；点 X 到直线距离 = `|(X − P₁) × û|`，
  `û = (P₂ − P₁)/|P₂ − P₁|`。

依据:自定——权重结构遵循「不同关节对姿势/运动影响不同」的度量原则
（[Motion Control 讲义](https://people.rennes.inria.fr/Ludovic.Hoyet/teaching/AMRG/AMRG_3_MotionControl.pdf)）；
速度型 effort 度量是 LMA 数值化的常见形态（[EMA](https://www.monicaperusquia.com/publications/2026-Siy-EMA.pdf)）。

### A.4 朝向 heading

- `right = normalize(pos(RightUpperLeg) − pos(LeftUpperLeg))`；
  `up = normalize(pos(head) − pos(hips))`；
  `forward = normalize(right × up)`（three 右手系，右手定则下 `right × up = forward`）。
- `heading(k) = atan2(forward.x, forward.z)`，输出为度。
- 角度差一律 wrap：`wrap(θ) = ((θ + 180) mod 360) − 180`，值域 (−180°, 180°]。
- 非人形回退：`forward = (0,0,1)` 经根骨骼世界四元数旋转后投影 XZ 归一。
- **turnTotal（累计转角）**：段/全片 `Σ_k |wrap(heading(k+1) − heading(k))|`——wrap 净差
  会掩盖整圈旋转（720° spin 的净差可为 0°），自转判定用 turnTotal（A.8 决策表 #6）。

依据:自定（解析几何推导）；缺左右腿骨骼时才走回退。

### A.5 根位移、moveSpeed、moveDir

- `rootPos(k) = pos(hips)`（**不用根骨骼**——绑定点常无位移语义；summary.rootJoint 注明 "hips"）。
- 平面速度：hips 速度取 XZ 分量再 `smooth(·, m=1)`；`moveSpeed(k) = |v_r(k)|`。
- **moveDir**：θ₀ = heading(0)；把 v_r 旋转 −θ₀（绕 Y 右手系）：
  `x' = vx·cosθ₀ − vz·sinθ₀`；`z' = vx·sinθ₀ + vz·cosθ₀`；
  `φ = atan2(x', z')`；`sector = round(φ / 45°) mod 8` →
  `[forward, forward-right, right, back-right, back, back-left, left, forward-left]`；
  `moveSpeed < 0.05` → `in-place`。
- 全片主方向 = moveSpeed ≥ 0.05 的帧的 sector 众数。
- **moveDirBody（相对当前朝向）**：同一公式把 θ₀ 换成 `heading(k)`——身体面向与运动方向
  解耦的判据（倒退走 = back、侧移 = left/right，strafe 类动作刚需）；
  `moveSpeed < 0.05` 同样记 in-place。段特征 `bodyDir` = 有效帧 sector 众数（A.8 #3/#4）。

依据:自定（8 方位离散化；sector 0 为正前）。

### A.6 接触与腾空

- 脚点集：每脚 `{Foot, Toe?}`（humanoid 命中 Toe 骨骼则加入）。
- `ground = min over 全片全部脚点的 y`。
- `contact_j(k) := (y_j(k) − ground < 0.05H) ∧ (|v_j(k)| < 0.30 H/s)`。
- `footContact(k)` = 该脚任一脚点 contact（OR）后**去抖**：状态翻转需连续 2 帧成立才生效
  （生效帧 = 翻转第一帧）。
- `airborne(k) = ¬L ∧ ¬R`（去抖后）；进入/退出帧为分段硬边界（A.7）。
- 支撑描述（每帧/每段）：双接触 `double-support`；单接触 `single-L` / `single-R`；无接触 `air`。
- **腾空统计（进 summary 全片统计）**：`maxRootYGain = max(rootY) − rootY(0)`（/H，
  仅 ≥ 0.05H 时输出，否则 null）；`airTime = airborne 帧数 × Δt`。

依据:外部——双阈值结构与 heel/toe 分列同
[NVIDIA Kimodo foot_detect_from_pos_and_vel](https://research.nvidia.com/labs/sil/projects/kimodo/docs/_modules/kimodo/motion_rep/feet.html)；
去抖参考 [kinemotion](https://pypi.org/project/kinemotion/0.41.1/) 的 min-contact-frames；
阈值数值为自定（身高归一代）。

### A.7 分段（segment.ts，六步顺序执行）

1. `Ê = smooth(E, m=2)`。
2. 候选极小：`i ∈ [1, N−2]` 满足 `Ê(i) < Ê(i−1) ∧ Ê(i) ≤ Ê(i+1)`；
   显著性过滤：设 L/R 为左右首个 Ê 局部极大，保留 `min(Ê(L), Ê(R)) − Ê(i) ≥ Δ_seg(0.08)` 者。
3. 硬边界并入：脚 contact 状态每次有效翻转帧、airborne 进/出帧（与候选合并去重排序）。
4. 切分成段；段长 < 0.4s（至少 3 帧）→ 并入「与该段平均 Ê 差更小」的相邻段（边界段并入唯一邻居）。
5. 相邻同 label 且同 guess 的段合并。
6. 段数 > 24 → 按段平均 Ê 升序逐段并入相邻段直到 ≤ 24。

**事件抽取（进 summary.events；全片 ≤ 32 条、同帧合并、按帧序）**：

- `liftoff` / `touchdown`：airborne 去抖后的进入/退出帧；
- `contact-change`：每次有效脚/肢翻转帧（带 side / limb tag）；
- `energy-peak`：每段 Ê 峰值帧（带段 guess）；
- `direction-change`：moveDir sector 变化且此后稳定 ≥ 3 帧的帧（带 from/to）；
- `spin`：turnTotal 累计跨越 270° 的首帧。

事件是叙事的锚点级证据（「frame 42 liftoff」），facts 句直接引用。

依据:外部——能量局部极小切分（PME，§6.0）；显著性是
[scipy find_peaks prominence](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.find_peaks.html)
的简化版（相邻极大替代完整基线搜索）；最短段长/上限为自定。

### A.8 段特征与 label/guess 决策表

段特征（先全部算好再查表）：`dur`；`meanE`（段内 Ê 均值）；`peakE`；`peakJoint`（段内 |v_j| 最大者，
平手取权重更大者）；`rootDisp = |planar rootPos(end) − rootPos(start)| / H`；`rootSpeed = rootDisp/dur`；
`turnNet = |wrap(heading(end) − heading(start))|`；`turnTotal`（A.4）；`bodyDir`（A.5 段众数）；
`airRatio`（airborne 帧占比）；`hipsLow = mean(段内 hips y) < P10(全片 hips y) − 0.05`。

决策表（**自上而下首条命中**；#2/#3 为 0.5.1 新增「末端主导 strike」前置判据——真实攻击资产交验
发现带垫步/转体的挥击被移动类规则抢先命中，3/4 首段误报 walk）：

| # | 条件 | label | guess |
|---|---|---|---|
| 1 | airRatio > 0.5 | airborne | 段内 hips 最高 − 段首 ≥ 0.05H（hipsRise）→ `jump`；否则 `fall`（落回原高的跳跃仍判 jump） |
| 2 | peakJointSpeed ≥ 3×max(rootSpeed, 0.1) ∧ meanE ≥ 0.8 ∧ dur ≤ 0.8s ∧ turnNet < 200° ∧ peakJoint ∈ {Hand, LowerArm} | action | `strike-punch`（末端主导） |
| 3 | 同 #2 但 peakJoint ∈ {Foot, LowerLeg, Toe} | action | `strike-kick`（末端主导） |
| 4 | rootSpeed ≥ 1.2 H/s | contact-move | `run` |
| 5 | rootSpeed ≥ 0.3 ∧ bodyDir = back | contact-move | `backpedal`（倒退走） |
| 6 | rootSpeed ≥ 0.3 ∧ bodyDir ∈ {left, right} | contact-move | `strafe-l` / `strafe-r`（侧移） |
| 7 | rootSpeed ≥ 0.3 H/s | contact-move | `walk` |
| 8 | turnTotal ≥ 270° | action | `spin`（自转/旋转攻击） |
| 9 | turnNet ≥ 45° ∧ rootSpeed < 0.3 | contact-move | `turn` |
| 10 | peakE ≥ 2.0 ∧ dur ≤ 0.8s ∧ peakJoint ∈ {Hand, LowerArm} | action | `strike-punch` |
| 11 | peakE ≥ 2.0 ∧ dur ≤ 0.8s ∧ peakJoint ∈ {Foot, LowerLeg, Toe} | action | `strike-kick` |
| 12 | hipsLow | action | `crouch` |
| 13 | meanE < 0.05 | idle | `idle` |
| 14 | 前一段 guess ∈ {strike-punch, strike-kick, jump, spin} ∧ meanE < 0.5×前段 meanE | action | `recover` |
| 15 | 兜底 | action | `gesture` |

vocab 条目按序匹配（when 只能引用本附录通道/特征值）：`label` 用词条替换该段 guess、
`suppress` 置 other、`demote` 降级 gesture——**label（idle/contact-move 等）恒由表内行判定**，
词条只作用于 guess（与把词条插在表前 first-match 等价）；summary 回显生效条目数与词表来源。

依据:自定（全部条件只引用已产出量，无隐藏输入）。

### A.9 强度档位

- 段强度 `level = max(levelMean(meanE), levelPeak(peakE))`（两表见 §6.6.2；**取更高级别**，
  避免高爆发短段被均值稀释）。**全片档只按均值**（`levelMean(meanE)`，CALIB v1 口径——真实攻击
  资产 4/4 全 extreme 暴露 max 口径在全片尺度无区分度，0.2s 轻击与 2.3s 大招同档；爆发性由分段档体现）。
- **relativeLevel（相对档位）**：段 meanE 对**本 clip Ê 分布**的分位——`< P50 → rel-low`；
  `P50–P90 → rel-mid`；`≥ P90 → rel-high`。与绝对 level 并列输出：绝对档跨资产可比，
  相对档解决「整体偏慢的资产里找相对爆发」（绝对阈值不动，守拍板 #3）。

依据:自定。

### A.10 姿势距离、循环/归位、bestLoopRange

- **P(k) 构造**：J15 世界位置 → 减 pos(hips) → 绕世界 Y 轴旋转 −heading(k)（公式同 A.5）→ /H。
- `poseRMS(a,b) = sqrt(mean_j |P(a)_j − P(b)_j|²)`；`maxJoint` = 单关节最大差；`worstJoints` = top3。
- seam 四分量（**末帧一律用 t=duration 精确评估**）：
  `poseMatch = poseRMS < 0.03 ∧ maxJoint < 0.08 ∧ |wrap(headingDiff)| < 10°`；
  `positionMatch = |planar rootPos(末) − rootPos(0)| < 0.05`；
  `velocityMatch = mean_j |v_j(末) − v_j(0)| < 0.10`。verdict 四态组合表见 §6.5.3。
- **bestLoopRange**：若 N > 300，取等距子网格 G（|G| = 300，含 0 与 N−1）；
  对全部 i<j ∈ G 且 (j−i)·Δt ≥ 0.5s：
  `score(i,j) = max(poseRMS(i,j)/0.03, rootDisp(i,j)/0.05, |wrapΔheading(i,j)|/10°, velSeam(i,j)/0.10)`
  ——四项各除以自身阈值成无量纲，取 max = 最保守维度，**不设权重**；
  取 score 最小对；`score < 1.5` 输出 `{frameStart, frameEnd, score, components}`，否则 null。
- `loopMode`：`strict`（缺省，四分量 max 打分）| `pose-only`（去掉 rootDisp 与 heading
  两项，只比 poseRMS 与 velSeam）——root-motion 步伐循环（姿势循环但位置前移）只有 pose-only
  能找到循环体；**verdict 不受影响**（四分量判定恒为 strict 口径）。

依据:外部——pose+velocity 组合度量是 Motion Graphs 过渡相似度的标准形态
（[cost = pose + vel (+ acc)](https://people.rennes.inria.fr/Ludovic.Hoyet/teaching/AMRG/AMRG_3_MotionControl.pdf)）；
归一化 max 打分为自定。

### A.11 关键帧挑选（report.ts）

优先级列表（每帧带 reason；cap 8；帧距 < 0.3s 视为重复，保留优先级高者）：

1. 全片 Ê 峰值帧（`energy-peak`）
2. 每段 Ê 峰值帧，段按 peakE 降序取前 6（`segment-peak:<guess>`）
3. A 峰值最高 2 帧（`amplitude-peak`）
4. bestLoopRange 的 i、j 两帧（`loop-seam`）
5. t=0 与 t=duration（`endpoints`）

renderRecipe = 帧列表 × [front, side] × 模式 skeleton（digest 同时给 bones-overlay 备选套）。

依据:自定。

### A.12 facts 句式模板（中文；{} 为工具填充，数值原样，禁止 Agent 改数）

- 段：`frame {a}–{b}：{支撑描述}，强度 {level}（均值 {meanE}、峰值 {peakE}），位移 {rootDisp} 身高，方向 {moveDir众数}，guess {guess}`
- 循环：`循环检测：{verdict}——姿势差 {poseRMS}，位置差 {rootDisp}，朝向差 {headingDiff}°，速度差 {velSeam}；{verdict 释义}`（释义四句固定文案，随 constants 提供）
- 全片：`总时长 {dur}s（{frameCount} 帧@30fps），平均强度 {level}，主方向 {dir}；循环 {verdict}`

依据:自定。

### A.13 trajectory SVG 规格

- `viewBox="0 0 480 480"`；世界 XZ → 画布：等比缩放 `s = 400/max(extent)`，
  `cx = 40 + (x − minx)·s`、`cy = 40 + (z − minz)·s`（纵横比保持，居中）。
- 元素顺序：浅色网格十字（中心线 + 边框）→ 路径 polyline（主题色）→ 每采样帧 r=2 圆点
  （fill = 五档强度色）→ 起点空心圆 r=6 → 终点实心方 8×8 → 起点 heading 箭头（长 24px）。
- **无可见文本**（免 locale）；单文件 ≤ 32KB；帧多时圆点按 stride 抽稀到 ≤ 600 个；路径超 32KB
  预算时按 2 的幂步长抽稀（终点恒保留，`<desc>` 元数据标注抽稀倍率——非可见文本，不违「无文本」）。

依据:自定。

### A.14 数值与边界

- 输出圆整：长度/速度 3 位小数，角度 1 位。
- 拒绝路径（三段式自愈）：无动画资产；N < 3（「片段过短」）；duration·f_s > 24000
  （建议降低 sampleFps）。
- `H ≤ 0` → normalize 降级 `none` + warning 透传（同单位体检口径）。
- **morph-only 动画**：clip 轨道全部为 blend shape / morphTargetInfluences、无骨骼轨道
  （表情/口型）→ 拒绝并自愈「形态动画：骨骼运动分析不适用，可用 kinemesh_render 逐帧查看」；
  骨骼 + morph 混合 → 正常分析 + warning 注明忽略的 morph 轨道数。

### A.15 常数总表（`core/motion/constants.ts` 单一来源，随输出回显）

| 常数 | 值 | 用于 |
|---|---|---|
| SAMPLE_FPS_DEFAULT | 15 | A.0 |
| SMOOTH_M | 2（窗宽 5） | A.2/A.7 |
| CONTACT_HEIGHT / CONTACT_VEL | 0.05H / 0.30 H/s | A.6 |
| DEBOUNCE_FRAMES | 2 | A.6 |
| SEG_DELTA / SEG_MIN_SECONDS / SEG_MAX_COUNT | 0.08 / 0.4s / 24 | A.7 |
| POSE_RMS / POSE_MAX | 0.03 / 0.08 | A.10 |
| ROOT_DISP_TH / HEADING_TH / VEL_SEAM_TH | 0.05 / 10° / 0.10 | A.10 |
| LOOP_GRID / LOOP_MIN_SECONDS / LOOP_PASS | 300 / 0.5s / 1.5 | A.10 |
| STRIKE_PEAK / STRIKE_DUR | 2.0 / 0.8s | A.8 |
| STRIKE_DOMINANCE / STRIKE_TURN_NET_MAX | 3 / 200° | A.8 #2/#3 |
| RUN_SPEED / WALK_SPEED / TURN_TH | 1.2 / 0.3 H/s / 45° | A.8 |
| SPIN_TH | 270° | A.7/A.8 |
| 强度档位表 | §6.6.2 五档 | A.9 |
| KEYFRAME_MAX / KEYFRAME_DEDUP | 8 / 0.3s | A.11 |
| TRAJECTORY_MAX_DOTS / TRAJECTORY_MAX_BYTES | 600 / 32768 | A.13 |
| LABELS_PER_SHOT | 12 | B.4 |
| CONVENTION_MIN | 0.5 | B.3 |

### A.16 阈值校准回路（让「初值待校准」可执行）

1. **样例集**：合成 rig（已知答案）+ 真实资产 N 个（FBX/glTF 各半，覆盖走/跑/打/跳/待机/旋转）
   入 `tests/fixtures/kinemesh/calib/`（文件 gitignore、清单入库）；
2. **快照断言**：每次改 `constants.ts` 必跑快照测试（summary 关键字段容差断言），防静默漂移；
3. **人工抽检**：facts 句 vs 关键帧截图一致性核对；不一致把「资产名/现象/调整原因」记进
   `constants.ts` 头注释（调整可追溯）；
4. **版本化**：常数表带 `CALIB_VERSION`，随 summary 回显——任何输出可追溯到哪一版校准。

## 附录 B 骨架映射算法规格（M7 实现唯一依据）

> 口径同附录 A：公式/常数/步骤定死；依据标注（外部/自定）。工具侧只保留
> 「字典查表（B.1–B.2）+ 约定识别（B.3）+ 标注截图（B.4）」，模糊/几何启发已砍（§7.1）
> ——识别缺口一律回退给 AI。

### B.0 canonical 部件集（白名单，映射产物只允许这些 id）

- CORE15（= J15）：`hips, spine, head, upperarm-l/r, lowerarm-l/r, hand-l/r, upperleg-l/r,
  lowerleg-l/r, foot-l/r`（一律小写，side 显式）。
- EXTRA（可选，接触检测用）：`toe-l/r, neck, chest`。
- **archetype**（映射文件声明）：`humanoid | quadruped | winged | multiped | chain | custom`。
  CORE15 只约束 humanoid；非 humanoid 走 `root / head / spine / limbs` 结构（B.5）与
  泛化通道（B.7）。

### B.1 名称归一

1. 原名 lowercase；**side 识别**：按 `[_:.\- ]+` 分词，token 恰为 `l`/`left` → side=L，
   `r`/`right` → side=R；都有或都无 → side=null（side 未知交给 AI 兜底流程经映射文件补，
   工具不做几何猜测）。
2. **剥前缀**（循环剥到不再匹配）：`mixamorig`、`bip001`、`bip01`、`bip`、`j_bip_c`、`j_sec_c`、
   `def_c`、`armature|`、`block`。前缀表开放于 vocab 同款扩展文件（§6.6.3 机制）。
3. 去掉 side token 与纯数字 token（`01` 等），得**主体 token 列表**。

依据:外部——[looseAutoMap](https://pub.dev/documentation/flutter3d_model_core/latest/flutter3d_model_core/looseAutoMap.html)
（synonym-and-prefix-tolerant）、[mixamo_converter](https://deepwiki.com/enziop/mixamo_converter/3.3-bone-renaming-options)
（namespace 剥离）、[Biped 骨骼参考](https://docs.otakusolutions.com/guide/biped-plus/ep21-biped-bones-reference?lang=en)。

### B.2 同义词表（L1；对主体 token **按表序精确匹配**，再对全名子串兜底；实现枚举序 = token 序 → 连接串最长 → 表序）

| canonical | 精确 token | 子串兜底 |
|---|---|---|
| toe | toe, toes, ball, toebase | thumb |
| foot | foot, feet, ankle | jiao |
| lowerleg | leg, calf, shin, knee, lowerleg | xiaotui |
| upperleg | thigh, upleg, upperleg | datui |
| hand | hand, palm, wrist | shou |
| lowerarm | forearm, lowerarm, elbow | xiaobi |
| upperarm | upperarm, arm, clavicle, collar, shoulder | gebo |
| head | head | tou |
| neck | neck | bozi |
| spine | spine, spine0–spine9, chest, torso | — |
| hips | hips, hip, pelvis | ku |

- **表序即优先级**：`forearm` 先于 `arm` 命中（lowerarm 行在上）——Mixamo `LeftArm`=upperarm、
  `LeftForeArm`=lowerarm、`LeftLeg`=lowerleg、`LeftUpLeg`=upperleg 语义由表序保证；
- 多骨命中同一 canonical：取 rest 高度**中位**者，其余丢弃并在 report 注明（spine 家族典型）。

依据:外部——[Modular Avatar Heuristic Bone Mapping](https://deepwiki.com/bdunderscore/modular-avatar/6.3-heuristic-bone-mapping)
（多约定 pattern → Unity HumanBodyBones 同构）；拼音 token 为自定补充。

### B.3 约定识别（convention）

- 家族指纹：mixamo=`mixamorig:` 前缀；biped=`bip0\d+[_ ]` 前缀；ue=`_(l|r)$` 后缀 ∧
  (thigh|calf|upperarm|lowerarm) token；vrm=`j_bip` 前缀；rigify=`(upper_arm|forearm|hand)\.[lr]$`。
- `score = 命中指纹骨骼数 / 总骨骼数`；convention = argmax 且 ≥ CONVENTION_MIN(0.5)，否则 `custom`。

依据:外部——[AnimationEQLabs](https://eqlabs.studio/animation/skeleton-inspector-rig-shortcuts/)
（UE4 Mannequin / MetaHuman / Mixamo / Daz / Custom 约定检测同构）。

### B.4 标注截图（stride 分批防叠）

- 骨骼序 = 层级 DFS 序；批数 `B = ceil(骨骼数 / LABELS_PER_SHOT(12))`；
  **第 i 批 = DFS 序号 ≡ i (mod B) 的骨骼**——相邻序号（父子骨，空间相邻）必然分属不同批，
  批内标签互不相邻，从根上避免重叠；骨骼总数 ≤ 12 时单批全量。
- 每视角（front、side）× 每批一张 PNG：skeleton 模式 + 关节世界位置放 canvas 文字精灵
  （骨骼名，14px 基准随距离缩放，Y 偏移 −6px）；相机拉远（distance×2.2）近似正交。
- 命名 `labels-<view>-<batch>.png`（batch 两位序号）。

依据:自定（stride 分批；文字精灵为 three 常规做法）。

### B.5 `kinemesh-bones.json`（映射文件）

```json
{
  "_meta": { "archetype": "quadruped", "convention": "custom", "by": "ai", "notes": "可选" },
  "root": "Body_Root",
  "head": "Head_01",
  "spine": ["Spine_01", "Spine_02"],
  "limbs": [
    { "role": "leg", "tag": "fl", "bones": ["Leg_FL_1", "Leg_FL_2"], "tip": "Foot_FL" },
    { "role": "tail", "bones": ["Tail_1", "Tail_2"], "tip": "Tail_2" }
  ],
  "bones": { "Head_01": "head" }
}
```

- `archetype ∈ B.0 枚举`；**humanoid**：只需 `bones`（CORE15 简写）；**非 humanoid**：
  `root` 必填，`head / spine / limbs` 按需，`bones` 字段此时忽略；
- `role ∈ {leg, arm, wing, tail}`；`tag` 自由短标签（fl/fr/bl/br/l/r…，仅展示用）；
- 发现顺序：`boneMap` 参数 > 资产同目录 `kinemesh-bones.json` > cwd > 无；
- **校验**（失败三段式报错并列合法值清单）：JSON 解析失败；archetype 非法；
  humanoid 时 value 不在 B.0 白名单 / 同一 CORE id 双骨 / CORE id 缺 side（`upperarm` → 报错，
  必须 `upperarm-l/-r`）；骨骼名不存在于骨架；limb bones 非连续链（子→父必须逐级相连）；
  `tip` 不是 bones 最后一节；leg 肢链数 > 8（建议复核 archetype）；
- 加载后 `summary.boneMap = {source, archetype, mapped}` 回显。

依据:外部形态——[retarget_bvh 手工映射 JSON](https://github.com/Diffeomorphic/retarget_bvh/wiki/Defining_The_Target_Rig_Manually)、
[BsKeyTools preset.list](https://deepwiki.com/AniBullet/BsKeyTools/4.1.2-bone-mapping-system)。

### B.6 与 info / analyze / render 集成

- `kinemesh_info`：`bones` 增 `convention`、`mapped: number`（parse 级计数；骨架名校验留给
  analyze/skeleton 消费点）；`humanoidLike` 保留 M1 口径（matchedCategories ≥ 4；提示位不驱动
  工具决策，重定义延后候选）。
- `kinemesh_analyze`：joints 解析顺序 = 映射文件 > 字典（B.1–B.2）> motion-top15
  （回退时 summary 注明并附「AI 补映射」指引）。
- `kinemesh_skeleton` digest 尾部固定**两级指引 fact**（中文）：
  「CORE15 缺口 {n} 个：① 读 skeleton-report.json，先判 **archetype**（人形/四足/带翼/多足/
  链形/自定义，参考结构统计 limbChains/groundTips/symmetryPairs）——人形按名称/层级/rest 坐标
  对应部位，非人形给出 root/head/脊柱/肢链 → 写 <资产目录>/kinemesh-bones.json（schema 见
  report 尾注）；② 命名不透明时以 shots:"all" 重跑取标注截图再定案 → 重跑 analyze」。
- `kinemesh_render` 支持 `boneLabels`（CLI `--bone-labels`）："auto"（缺省第 1 批）| 批次号整数 |
  "all"（全部骨骼名，允许重叠，调试用）；与 mode:skeleton / bones-overlay 联用时在该批截图上画
  骨骼名文字精灵（B.4；批次按**全骨架** stride 划分，B = ceil(骨骼总数/12)）。
  `kinemesh_skeleton` 的 shots:auto/all 直接渲染标注截图（每批 × front/side，
  `labels-<view>-<两位批次>.png` 落 run 目录、进 files[] 与 digest.shots；批次清单以 report 的
  batches 为准直发骨骼名，不受全骨架批号偏移影响；缺 playwright 时降级只出 report + 三段式安装指引）。

### B.7 非人形通道泛化（archetype ≠ humanoid 时覆盖附录 A 对应定义）

- **分析关节集 AS**：`{root, head（若有）, spine 中位骨（若有）, 每条 limb 的首/中/末骨}`；
  limb 数 > 8 时取「位移方差 Top-8」；AS 上限 27。
- **能量权重**（链位规则，与 J15 表同源）：root 0.2，spine 0.3，head 1.0；limb 首 0.6 /
  中 0.8 / 末（tip）1.0（两节链取首 0.6、末 1.0）；tail 同 limb 口径；
  `E(k) = Σ w·|v| / Σ w` 同 A.3。
- **heading 回退序**（依次尝试，失败下一步）：
  ① 存在左右对称 leg 且有 head → A.4 原式（right × up）；
  ② 有 head → `atan2` of normalize(pos(head) − pos(root)) 投影 XZ（quadruped 通常命中）；
  ③ 根骨骼世界四元数 × (0,0,1) 投影归一。
- **接触（贴地肢链）**：贴地 limb = tip 的 **rest 高度**与「全部 limb tip 最低高度」差 < 0.05H
  的 limb（role 视为 leg，无论映射里写的什么 role——映射 role 仅供展示）；对这些 tip 施加
  A.6 双阈值与去抖（不要求 foot/toe 命名，人形 foot/toe 即特例）；
  无任何贴地 limb（鱼 / 飞行 rest pose / chain）→ contact 全 null + warning，airborne 不输出。
- **amplitude 末端集**：非贴地 limb 的 tips + head（人形「双手双脚 + head」的推广）。
- **P(t)**：关节集换 AS，A.10 其余流程（减 root、转 −heading、/H、RMS）不变。
- **接触分组实现口径**：footPoints 带 tag（人形 l/r，非人形 = limb.tag）；同一 tag 多点 OR →
  双阈值 → **按 tag 去抖**；`contactL/R` = 侧别聚合（sideOfLimbTag：fl/bl/l→L、fr/br/r→R，
  无侧别 tag 两侧同值）；frames.csv 新增 **`contactTags` 列**（命中 tag 按 '+' 连接、字母序）；
  支撑态扩展：≥3 命中 = `multi-support`，无接触点 = `n/a`（airborne 恒 false）。
- **肢链方差排序**：粗网格（≤5fps、≤60 点）FK 预采样 + Welford 在线方差，只用于 Top-8 排序
  （方差并列按映射顺序，确定性）；AS 超 27 时按 mid → base 顺序让位（tip 最后丢）。
- **summary**：`archetype` 必出；≠ humanoid 时附阈值口径 warning（§7.2）。

依据:自定——泛化规则保证与 J15 特例兼容（人形映射下各条退化为附录 A 原式）；贴地判定的
「rest 高度贴地 = 腿」与 A.6 双阈值一脉相承。
