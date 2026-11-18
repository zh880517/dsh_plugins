# 动析 kinemesh（DSH 插件）

面向游戏 3D 模型/动画资源的 AI 预览与分析：kine（运动/动画）+ mesh（模型）。

## 功能

- **`kinemesh_info`**（Agent 工具）：读取 FBX / glTF / GLB / OBJ，返回动画片段清单（名称/时长/
  通道数/根运动）、骨骼统计（数量/深度/人形识别）、网格统计（三角面/顶点/蒙皮比例/材质数）、
  贴图清单、包围盒与单位体检（厘米未换算这类坑会标出来）。
- **`kinemesh_render`**（Agent 工具）：按视角（球坐标 view 或 front/side/back/three-quarter/orbit8
  预设）+ 帧号渲染 PNG，返回绝对路径数组；支持线框/骨骼/骨骼叠加模式。需要本机
  playwright + chromium（`npm i playwright && npx playwright install chromium`）。
- **预览面板**（会话输入框左侧「动析」）：加载模型路径 → 拖转/拖帧/播放/模式切换 →
  一键「发送给 AI 分析」（把当前视角交给会话里的 Agent，走 kinemesh_render 截图并读图）。
- **Skill + CLI**（[skill/](./skill/)）：`SKILL.md + cli/kinemesh.cjs` 自包含技能目录，
  任何有 shell + Node 的 Agent 复制即用。
- **MCP Server**（[mcp/](./mcp/)）：stdio，两工具与 DSH / CLI 同名同参。

- 支持格式：FBX（ASCII ≥7.0 / 二进制 ≥6400）、glTF / GLB（含 VRM）、OBJ
- 暂不支持：`.max` 等私有格式（给出离线转换指引）；`.blend` 等长尾格式的 assimpjs 兜底暂缓
- 本地只读分析：只读模型文件本身，不联网、不写模型所在目录（截图写到临时目录或指定目录）

Agent 用法（任选一）：

```
kinemesh_info({ "path": "D:/assets/characters/hero.fbx" })
kinemesh_render({ "path": "D:/assets/characters/hero.fbx", "clip": "Run", "frames": [0, 15, 30], "viewPreset": "front" })
```

[完整文档](../../docs/plugins/kinemesh/README.md)
