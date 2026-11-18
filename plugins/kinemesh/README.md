# 动析 kinemesh（DSH 插件）

面向游戏 3D 模型/动画资源的 AI 预览与分析。当前阶段（M1）提供 Agent 工具 **`kinemesh_info`**：
读取 FBX / glTF / GLB / OBJ 文件，返回动画片段清单、骨骼统计（含人形识别）、网格统计、
贴图列表、包围盒与单位体检。

- 支持：FBX（ASCII ≥7.0 / 二进制 ≥6400）、glTF / GLB（含 VRM）、OBJ
- 暂不支持：`.max` 等私有格式（会给出离线转换指引）；`.blend` 等长尾格式的 assimpjs 兜底在后续里程碑
- 本地只读分析：只读模型文件本身，不联网、不写入模型所在目录

Agent 用法（任选一）：

```
kinemesh_info({ "path": "D:/assets/characters/hero.fbx" })
```

[完整文档](../../docs/plugins/kinemesh/README.md)
