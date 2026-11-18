# kinemesh MCP Server（动析）

stdio MCP 服务器，把 **`kinemesh_info`** / **`kinemesh_render`** 两个工具暴露给任何支持 MCP 的宿主
（参数与返回结构和 DSH 插件、CLI 完全同名同参，见 [../docs/plugins/kinemesh/design.md](../../docs/plugins/kinemesh/design.md)）。

`kinemesh-mcp.js` 是单文件 ESM bundle（MCP SDK 与解析/渲染核心全内联）。**`kinemesh_render` 需要本机
playwright + chromium**（`npm i playwright && npx playwright install chromium`；`kinemesh_info` 无额外依赖）。

## 客户端配置

```json
{
  "mcpServers": {
    "kinemesh": {
      "command": "node",
      "args": ["/绝对路径/plugins/kinemesh/mcp/kinemesh-mcp.js"]
    }
  }
}
```

文件在本仓库内原位运行即可（ESM 依赖同目录的 `plugins/kinemesh/package.json`），不需要复制目录。

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `kinemesh_info` | `path` | 动画片段/骨骼/网格/贴图/包围盒/单位体检 JSON |
| `kinemesh_render` | `path`, `frames`(必填), `clip`?, `view`? \| `viewPreset`?, `mode`?, `width`?, `height`?, `out`? | `{ images: [PNG 绝对路径…] }` |
