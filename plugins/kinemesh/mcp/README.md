# kinemesh MCP Server（动析）

stdio MCP 服务器，把 **`kinemesh_info`** / **`kinemesh_render`** / **`kinemesh_analyze`** /
**`kinemesh_skeleton`** 四个工具暴露给任何支持 MCP 的宿主
（参数与返回结构和 DSH 插件、CLI 完全同名同参，见 [../docs/plugins/kinemesh/design.md](../../docs/plugins/kinemesh/design.md)）。

`kinemesh-mcp.js` 是单文件 ESM bundle（MCP SDK 与解析/渲染核心全内联）。**`kinemesh_render` 需要本机
playwright + chromium**（`npm i playwright && npx playwright install chromium`；`kinemesh_info` /
`kinemesh_analyze` / `kinemesh_skeleton` 无额外依赖）。

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
| `kinemesh_info` | `path`, `mesh`?（独立 mesh 文件：返回网格报告 + 绑定体检） | 动画片段/骨骼/网格/贴图/包围盒/单位体检 JSON（带 mesh 时另有 `companion` / `binding` 段） |
| `kinemesh_render` | `path`, `frames`(必填), `mesh`?（动作-only 资产用独立网格文件；不传时自动识别同资产网格文件）, `clip`?, `view`? \| `viewPreset`?, `mode`?, `width`?, `height`?, `out`? | `{ images: [PNG 绝对路径…], binding? }` |
| `kinemesh_analyze` | `path`, `clip`?（`"*"` 批量）, `range`?, `sampleFps`?, `joints`?, `detail`?, `curvesFor`?, `smooth`?, `loopMode`?, `normalize`?, `vocab`?, `boneMap`?, `out`? | `{ dir, files, summaryDigest（分段/全片统计/loopCheck/keyframeRender 配方）, warnings? }` |
| `kinemesh_skeleton` | `path`, `shots`?（`auto`/`none`/`all`）, `boneMap`?, `out`? | `{ dir, files, summaryDigest（convention/unmapped/两级指引 fact）, warnings? }` |

`analyze` 输出目录缺省 `<当前工作目录>/.kinemeshtmp/run-<时间戳>-<pid>/`（读文件被沙箱拦截时用 `out` 重跑指向工作区）；
`skeleton` 的 `shots:"auto"` 仅在 CORE15 有缺口时渲染标注截图批次。
