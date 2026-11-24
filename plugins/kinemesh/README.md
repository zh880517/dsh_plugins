# 动析 kinemesh（DSH 插件）

面向游戏 3D 模型/动画资源的 AI 预览与分析：kine（运动/动画）+ mesh（模型）。

## 功能

- **`kinemesh_info`**（Agent 工具）：读取 FBX / glTF / GLB / OBJ，返回动画片段清单（名称/时长/
  通道数/根运动）、骨骼统计（数量/深度/人形识别）、网格统计（三角面/顶点/蒙皮比例/材质数）、
  贴图清单、包围盒与单位体检（厘米未换算这类坑会标出来）。
- **`kinemesh_render`**（Agent 工具）：按视角（球坐标 view 或 front/side/back/three-quarter/orbit8
  预设）+ 帧号渲染 PNG，返回绝对路径数组；渲染模式 default / solid / wireframe / skeleton /
  bones-overlay，**省略 mode 时按模型自动选**（无 mesh→骨架；贴图解不出来→素模；有可用贴图→default）；
  只给视角预设时**逐帧按身体包围盒自动取景**（带位移的动作不会跑出画面）。需要本机
  playwright + chromium（`npm i playwright && npx playwright install chromium`）。
- **预览面板（0.6.0 起三入口）**：左侧侧边栏「动析」打开**独立预览页**（拖转视角、播放条
  首帧/逐帧/播放暂停/末帧、轨道条拖帧 + 强度曲线、播放速度 0.1×～2×、显示方式=素模/贴图/线框
  + 独立「叠加骨架」、载入后自动选显示模式、「锁定位移 / 锁定旋转」去掉 root motion、角色根节点
  XYZ 参考轴、左下角全局轴指示器）；会话内另有 `/kinemesh` 命令（拖入 FBX + 要求直接启动分析）
  与「模型预览」页签（会话模型列表 + 发送给 AI 分析）。
- **Skill + CLI**（[skill/](./skill/)）：`SKILL.md + cli/kinemesh.cjs` 自包含技能目录，
  任何有 shell + Node 的 Agent 复制即用。
- **MCP Server**（[mcp/](./mcp/)）：stdio，两工具与 DSH / CLI 同名同参。

- 支持格式：FBX（ASCII ≥7.0 / 二进制 ≥6400）、glTF / GLB（含 VRM）、OBJ
- 暂不支持：`.max` 等私有格式（给出离线转换指引）；`.blend` 等长尾格式的 assimpjs 兜底暂缓
- 本地只读分析：只读模型文件本身，不联网、不写模型所在目录（截图与分析中间文件缺省写到
  当前工作目录下的 `.kinemeshtmp/run-<时间戳>-<pid>/`，`KINEMESH_TMP_DIR` 可覆盖）

Agent 用法（任选一）：

```
kinemesh_info({ "path": "D:/assets/characters/hero.fbx" })
kinemesh_render({ "path": "D:/assets/characters/hero.fbx", "clip": "Run", "frames": [0, 15, 30], "viewPreset": "front" })
```

[完整文档](../../docs/plugins/kinemesh/README.md)
