# kinemesh（动析）架构设计

> 状态：v0.2（M1 已实施）。定稿输入来自 `docs/dev/2026-11-18-kinemesh-design.md`（草稿评审版，
> 全部落地后删除）；本文是长期有效的正式文档。

## 1. 定位与三出口

**kinemesh = kine（运动/动画） + mesh（模型）**，中文展示名「动析」。
面向游戏 3D 模型/动画资源，服务两类场景：

1. **AI 读信息**：提取动画片段清单、骨骼结构、网格统计、比例/单位体检；
2. **AI 看画面**：按视角 + 帧号渲染截图，供 Agent 视觉分析。

三个出口共用同一个 core，工具**同名、同参数、同返回结构**：

| 出口 | 载体 | 状态 |
|---|---|---|
| DSH 插件 | `plugins/kinemesh/`（host 工具 + client 预览面板） | M1 部分交付（仅 `kinemesh_info`），M3 完整 |
| Skill + CLI | Skill 目录 + 单文件 CLI bundle | M4 |
| MCP Server | stdio，zod schema 与 DSH 同名同参 | M5 |

## 2. 总体架构

```
plugins/kinemesh/src/
  host.ts          DSH Host 入口（inject: ['tools']；M3 追加 webServer 路由）
  tools.ts         Agent 工具（kinemesh_info；M2 追加 kinemesh_render）
  client.tsx       DSH Client 入口（M1 占位；M3 预览面板）
  core/            与出口无关的纯能力层（不依赖宿主 API）
    registry.ts    格式注册表 + 未识别格式的自愈指引
    analyze-file.ts  顶层入口：buffer + 文件名 → InfoReport
    types.ts       CanonicalScene / InfoReport / FormatEntry
    errors.ts      KinemeshError（错在哪 + 正确姿势）
    loaders/       fbx（three FBXLoader）· obj · gltf（GLTFLoader，viewer 用）· node-textures
    analyze/       scene-info（场景→InfoReport）· gltf-json（纯 JSON 快速路径）
                   humanoid（人形命名惯例）· units（单位体检）
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
CanonicalScene 路径（GLTFLoader）保留给 viewer / 截图（M2/M3）。

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
- **测试**：`tests/kinemesh/screenshot.int.test.ts` 用合成 FBX 走真实 chromium 渲染
  （两帧内容不同、尺寸正确、orbit8 八张、空 frames 报错）；chromium 缺席时整组跳过。

## 4. 数据流

```
模型文件 (ArrayBuffer + fileName)
  → detectFormat(head, fileName)               # registry
  → fastInfo?                                  # glTF/GLB：纯 JSON → InfoReport
  → load() → CanonicalScene                    # FBX/OBJ：three 场景
  → sceneToInfo(scene)                         # 场景 → InfoReport
  → kinemesh_info 返回 { ok:true, ...report }  # JSON
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
| M3 | DSH 插件完整链路（预览面板 + 发送给 AI + `kinemesh_render`） | 待做 |
| M4 | Skill + CLI 打包（esbuild 单文件 + SKILL.md） | 待做 |
| M5 | MCP Server（stdio） | 待做 |

开放问题（草稿 §10）的处理约定：

- 截图输出目录：默认系统临时目录，`out` 参数可指定（M2 实施时确认）；
- 性能预算：`kinemesh_info` 文件上限 512 MiB（超出给减负指引），工具超时 60s；
- BVH 重定向 / 多模型对比：v1 不做；
- 预览面板入口形态：参考 aiworkflow 的主面板 + 胶囊模式（M3 定稿）；
- 长尾格式（.blend 等）assimpjs 兜底：M2/M4 视体积与稳定性接入，当前给离线转换指引。
