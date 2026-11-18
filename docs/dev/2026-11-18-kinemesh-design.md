# kinemesh 架构设计方案（草稿）

- 状态：**草稿 v0.1 → M1 已实施（2026-11-18）**。M1 的结论已回写
  [docs/plugins/kinemesh/design.md](../plugins/kinemesh/design.md)（core 结构、three.js 构建期依赖、
  Node 贴图桩、glTF 快速路径、rootMotion/单位体检口径、测试策略、开放问题的默认决定）；
  本文档保留到全部里程碑定稿，最终删除。
- 日期：2026-11-18
- 定稿后去向：本文档删除

---

## 1. 定位与命名

**kinemesh** = kine（运动/动画） + mesh（模型）；中文展示名「**动析**」。

一句话定位：**面向游戏 3D 模型/动画资源的 AI 预览与分析工具**。

服务两类核心场景：

1. **AI 读信息**：Agent 拿到模型文件，提取动画片段清单、骨骼结构、网格统计、比例/单位体检，回答「这个资源有哪些动作、多长、能不能用」；
2. **AI 看画面**：按指定视角 + 帧号渲染截图，供 Agent 视觉分析（动作姿势检查、模型审查、关键帧 contact sheet）。

**三个分发形态**（共用同一个 core）：

| 形态 | 载体 | 交互能力 |
|---|---|---|
| DSH 插件 | `plugins/kinemesh/` | 富交互：网页预览、转角度、拖进度条、播放、发送给 AI |
| Skill + CLI | Skill 目录（SKILL.md + 捆绑 CLI） | 任何有 shell 的 Agent 可用，复制目录即用 |
| MCP Server | stdio / HTTP | 只支持 MCP 的宿主连接，结构化参数 |

## 2. 总体架构

```
┌───────────────────────────────────────────────────────┐
│  core（与出口无关的纯能力层）                             │
│                                                       │
│  ├── loaders/    格式探测 + Loader 注册表 → 统一场景     │
│  ├── analyze/    动画/骨骼/网格信息提取（info 的实现）    │
│  ├── viewstate/  ViewState 规范 + 校验                  │
│  ├── viewer/     浏览器查看器模块（框架无关，挂 DOM 即用） │
│  └── render/     无头截图管线（viewer + Playwright）     │
└───────────────┬───────────────────────────────────────┘
                │ 同一 core，三个薄壳
    ┌───────────┼─────────────────┐
    ▼           ▼                 ▼
 DSH 插件    Skill+CLI         MCP Server
（host 工具   （单文件 CLI      （stdio，
 + client     bundle +          zod schema
 预览面板）    SKILL.md）        与 DSH 同名同参）
```

**设计原则**：

- 所有出口的工具**同名、同参数、同返回结构**（`kinemesh_info` / `kinemesh_render`），一份 zod schema 三处复用；
- viewer 模块在 DSH Client 预览与 Playwright 截图页之间**同源共用**，保证「预览里看到的构图 = AI 截图分析拿到的画面」；
- core 不依赖任何宿主 API（无 DSH / MCP / Node 专属耦合），浏览器半与 Node 半各自裁剪引入。

## 3. 格式支持策略（glTF 中间格式）

### 3.1 版本一格式矩阵

| 路径 | 格式 | 动画 | 说明 |
|---|---|---|---|
| 原生加载 | **FBX** | ✅ | 主格式。Max/Maya/Blender/Mixamo 管线；ASCII ≥7.0 / 二进制 ≥6400 |
| | glTF / GLB（含 VRM） | ✅ | Web/手游/Godot；Draco / Meshopt / KTX2 解码第一版带上 |
| | OBJ + MTL | ❌ | 静态模型最通用 |
| assimpjs 兜底 | .blend / .3ds / .ase / .dae / SMD / MD5 等长尾 | 部分 | WASM 内存转 glTF → GLTFLoader |

### 3.2 glTF 作为中间格式（枢纽策略）

FBX **保留原生直载**（主格式不经转换最保真），glTF 枢纽用在三处：

1. **长尾格式兜底**：assimpjs 在内存转 glTF，不为每个格式写加载器；
2. **私有格式预处理入口**：NIF / PSK / GR2 等无 JS 解析器的格式，离线（Blender 插件 / FBX2glTF / Noesis）转 GLB 后进入本工具；
3. **canonical 内部表示**：需要统一内部表示的场合（如后续批量处理）以 GLB 为准。

转换保真要点（写入 Skill 文档与错误提示）：

- 约束 / IK 必须**烘焙成关键帧**再导出；
- FBX 动画层会被**拍平**（播放结果一致，层结构丢失）；
- 多 take → glTF `animations[]` 多片段；
- FBX 厘米 → glTF 米自动换算（消掉 100 倍缩放坑）；
- 动画关键资产的转换用 FBX2glTF / Blender bpy，**不走 assimp**（动画质量不稳）。

### 3.3 明确不支持与降级策略（错误自愈文案）

| 输入 | 行为 |
|---|---|
| `.max` | 报错 + 指引：「在 3ds Max 中 文件 → 导出 → FBX（勾选烘焙动画 / 嵌入媒体）后重试」 |
| `.blend` 且解析后无动画片段 | 正常返回静态信息，附加提示：「Blender 源文件动画支持有限，建议导出 GLB/FBX 后分析」 |
| 未知/私有格式 | 报错 + 指引离线转 GLB 路线 |
| 包围盒异常（如人形 > 10m） | info 结果附「疑似单位错误（FBX 厘米未换算）」体检标记 |

## 4. core 设计

### 4.1 Loader 注册表

```ts
interface FormatEntry {
  detect: (head: Uint8Array, filename: string) => boolean; // magic bytes 优先，扩展名兜底
  load: (data: ArrayBuffer, ctx: LoadContext) => Promise<CanonicalScene>;
  hasAnimation: boolean;
}
```

统一输出 `CanonicalScene`：

```ts
interface CanonicalScene {
  object: THREE.Object3D;            // 场景根
  animations: THREE.AnimationClip[]; // 统一成 three.js clip
  meta: SceneMeta;                   // 单位、轴制、来源格式、fps 线索
}
```

新增格式 = 注册一个 entry，viewer / 工具层零改动。

### 4.2 ViewState 规范（三出口通用的「画面坐标」）

```jsonc
{
  "camera": {
    "azimuth": 45,       // 方位角°，绕 Y 轴
    "elevation": 15,     // 仰角°
    "distance": 3.2,     // 与 target 的距离（模型单位）
    "target": [0, 1, 0], // 注视点
    "fov": 40
  },
  "clip": "Run",
  "frame": 35,           // 帧号；与 clip.fps 换算 time = frame / fps
  "mode": "default"      // default | wireframe | skeleton | bones-overlay
}
```

- 用**球坐标**而非 position 数组：紧凑、AI 读写不易错、无 up-axis 歧义；core 内部换算 three.js 位置；
- `mode` 覆盖分析常用渲染模式：骨骼可视化（skeleton / bones-overlay）是动作分析刚需；
- 预设别名 `viewPreset: "front" | "side" | "back" | "three-quarter" | "orbit8"`（orbit8 = 八方位连拍）。

### 4.3 info 提取（`kinemesh_info` 返回设计）

```jsonc
{
  "format": "fbx",
  "clips": [{
    "name": "Run", "duration": 1.67, "fps": 30,
    "channels": 62, "rootMotion": true
  }],
  "bones": { "count": 63, "maxDepth": 6, "humanoidLike": true },
  "meshes": [{ "name": "Body", "triangles": 18432, "skinnedRatio": 0.97, "materials": 2 }],
  "textures": [{ "name": "body_diffuse.png", "size": [1024, 1024] }],
  "bounds": { "min": [...], "max": [...], "heightMeters": 1.8 },
  "warnings": ["疑似单位错误：包围盒高度 180，可能是厘米未换算"]
}
```

- `rootMotion`：根骨骼位移通道是否非零（游戏复用动作的关键判断）；
- `humanoidLike`：骨骼命名与层级匹配常见 Humanoid 惯例（hips/spine/head…），提示可重定向；
- **glTF 快速路径**：`animations[].samplers` 的 accessor min/max 是纯 JSON，不碰二进制 buffer 即可得出片段名/时长/通道数。

### 4.4 viewer 模块（浏览器半）

框架无关（不绑 React），API：

```ts
mount(el: HTMLElement, opts): ViewerHandle
// setViewState / getViewState / loadModel(buffer, filename)
// play / pause / seek(frame) / frameInfo()
```

- OrbitControls 拖转即更新 ViewState（球坐标实时回读）；
- 时间轴 = clip 帧号 scrub + 播放（AnimationMixer）；
- DSH Client 与 Playwright 截图页**同一模块**，构图一致。

### 4.5 截图管线（Node 半）

- Playwright(chromium) + 内嵌 viewer 的独立 HTML（构建期从 core 产出，随包分发）；
- 输入：模型文件 + ViewState（或 viewPreset）+ `frames: number[]`（批量）；
- 输出：PNG 落盘（默认临时目录，路径可指定），返回绝对路径数组；
- 批量接口摊薄浏览器冷启动（`--frames 30,35,40` 一次进程出多图）；
- 浏览器进程按次启停，**不做常驻服务**（红线）。

## 5. 三个出口设计

### 5.1 DSH 插件（`plugins/kinemesh/`）

```
plugins/kinemesh/
  package.json        # dsh.bundle.patch + dsh.client，包名 @kinemesh/dsh-plugin（待查重）
  cordis.patch.yml
  src/host.ts         # inject: ['webServer', 'tools']；/kinemesh 前缀路由
  src/tools.ts        # kinemesh_info / kinemesh_render → 调 core
  src/client.tsx      # React 面板（slot 注入）内嵌 viewer 模块
  market.json         # 标题「动析 kinemesh — 三维模型动画预览分析」
```

- 预览面板：模型加载（文件/路径）→ 转角度 / 拖帧 / 播放 / 模式切换；
- **「发送给 AI 分析」按钮**：Client 取当前 ViewState → Host client-callable 入口 → `agent.inject()`（带模型路径、clip、帧号、视角描述）+ `agent.followup()` 唤醒 → AI 调 `kinemesh_render` 截图 → 读图分析；
- UI 规则：React 组件进 slot、不用 iframe、主题 token、样式类名带 `kinemesh-` 前缀；
- ⚠️ 实现时需 `cordis_inspect_query` 验证：remote command 入口、`agent.inject`/`followup` 确切签名、工具结果能否内嵌图片（稳妥路径：返回 PNG 路径，Agent 用读图工具查看）。

### 5.2 Skill + CLI

```
<skill-dir>/
  SKILL.md            # 何时用 / 命令格式 / 输出结构 / ViewState 说明 / 转换指引（.max 等）
  cli/kinemesh.js     # esbuild 单文件 bundle（three.js + core 全内联），免 npm install
```

- 子命令：`info <file>` / `render <file> --clip Run --frame 35 --azimuth 45 --out shot.png`；
- 契约：stdout 出 JSON、图片落盘、非零退出码 + stderr 报错（Agent 解析友好）；
- 宿主要求：有 shell + Node（DSH / Claude Code / Codex CLI 等均满足）。

### 5.3 MCP Server

- `@modelcontextprotocol/sdk`，stdio 传输起步（HTTP 备选）；
- 工具 `kinemesh_info` / `kinemesh_render` 与 DSH / CLI 同名同参（共享 zod schema）。

## 6. 工具 schema（草案）

```
kinemesh_info(path, { clip? }) → info JSON（见 4.3）

kinemesh_render(path, {
  clip, frames: number[],       # 必填：渲哪些帧
  view?: ViewState,             # 与 viewPreset 二选一
  viewPreset?: "front"|"side"|"back"|"three-quarter"|"orbit8",
  mode?: "default"|"wireframe"|"skeleton"|"bones-overlay",
  width?: 1280, height?: 720, out?: string
}) → { images: string[] }       # PNG 绝对路径数组
```

## 7. 技术栈

| 用途 | 选型 | 备注 |
|---|---|---|
| 解析/渲染 | three.js（FBXLoader / GLTFLoader / Draco / Meshopt / KTX2 / OrbitControls / AnimationMixer） | 浏览器与 Node 共用；构建期内联插件产物 |
| 兜底格式 | assimpjs（WASM） | 内存转 glTF |
| 截图 | Playwright（chromium） | 按次启停，无常驻服务 |
| MCP | @modelcontextprotocol/sdk | stdio 起步 |
| Schema | zod | 三出口共用 |
| 构建 | TypeScript strict + ESM + esbuild | CLI 单文件 bundle |
| 测试 | vitest | 解析层纯逻辑 + 截图金图对比 |

版本号立项时钉住；相对导入带 `.js` 扩展名（仓库编码约定）。

## 8. 非目标（明确不做）

- `.max` 直接解析（私有格式，无开源解析器）；
- 常驻 HTTP 服务、install / hook 宿主集成、专有 SDK 适配（仓库红线）；
- 通用格式转换服务（FBX2glTF 等仅作为文档指路，不打包进工具）；
- 模型编辑 / 导出 / 重定向执行（BVH 重定向**是否做**见开放问题）。

## 9. 里程碑（草案）

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | core：Loader 注册表 + info 提取（FBX/glTF/OBJ） | CLI 脚本对样例文件输出正确 info |
| M2 | viewer 模块 + 截图管线 | 独立 HTML 页可交互预览；命令行按 ViewState 出 PNG |
| M3 | DSH 插件（tools + 预览面板 + 发送给 AI 链路） | 新会话可装可用，Agent 完成一次「收到视角 → 截图 → 分析」闭环 |
| M4 | Skill + CLI 打包 | 干净目录复制到 Claude Code 可用 |
| M5 | MCP Server | MCP 客户端连上并调通两工具 |

## 10. 待补充 / 开放问题（等Owner输入）

- [ ] 预览面板入口形态：主面板 / 浮层 / 胶囊（参考 aiworkflow 的面板模式？）
- [ ] 截图输出目录约定：系统临时目录 vs 会话工作区 vs 可配置
- [ ] BVH 动作重定向（mocap → 模型骨架）是否纳入范围
- [ ] 多模型同场景对比是否需要
- [ ] 性能预算：模型面数/文件大小上限、截图超时、Playwright 冷启动容忍度
- [ ] 证书/许可确认：three.js(MIT)、assimpjs、Playwright(Apache-2.0)、@modelcontextprotocol/sdk
- [ ] npm 包名查重：`@kinemesh/dsh-plugin`、MCP 包名、CLI bundle 命名
- [ ] market.json 中文标题/描述/关键词定稿
- [ ] 样例资产清单（各格式 + 带动画/不带动画各若干，用于测试与金图）
- [ ] `docs/README.md` 尾注「项目只面向 DeepSeek Harness 插件…」与 AGENTS.md 新政策（Skill/MCP 允许）不一致，需同步更新（定稿时处理）

## 11. 与仓库现有约定的衔接

- 新建 `plugins/kinemesh/` 时同步建 `docs/plugins/kinemesh/{README,design}.md` 并补根 README 与 `docs/README.md` 链接、market 条目（`npm run check:docs` 会拦）；
- 遵循：构建产物必须提交、改代码必须 bump 版本、命名空间前缀（`/kinemesh` 路由、`kinemesh-` 类名/row id）、插件间不互相 import；
- Skill 与 MCP 的目录落点（`plugins/kinemesh/` 内 or 仓库顶层新目录）**待定稿后**同步进 AGENTS.md 目录结构一节（本次不动）。
