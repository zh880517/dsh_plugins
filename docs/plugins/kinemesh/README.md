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
- 本地只读分析：只读模型文件本身，不联网、不写模型所在目录。

当前版本 0.5.0：M1–M7 已全部实施——四工具 `kinemesh_info` / `kinemesh_render` / `kinemesh_analyze` /
`kinemesh_skeleton` 三出口同名同参，M6/M7 状态见 [design.md](./design.md) §5。

## 安装

在 DSH 侧栏 **Plugins → Add plugin** 里粘一条 spec：

```
git+https://github.com/zh880517/dsh_plugins.git#main&path:/plugins/kinemesh
```

钉版本用包含构建产物的 commit（`npm run release:plugin -- --only kinemesh` 会打印）。

## 边界

- `.max` 等私有工程格式不解析，会返回带离线转换指引的自愈文案；
- `.blend` / NIF / PSK / GR2 等长尾格式在后续里程碑接入 assimpjs 兜底，当前阶段同样给指引；
- 不做模型编辑 / 导出 / 重定向执行；
- 浏览器进程按次启停做截图，不做常驻服务。

## 数据与权限

- 不建数据库、不写 `~` 下任何目录；`kinemesh_info` 只读 Agent 给出的路径。
- 后续截图功能默认把 PNG 写到系统临时目录（路径可指定）。

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
