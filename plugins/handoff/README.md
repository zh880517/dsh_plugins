# @handoff/dsh-plugin

DeepSeek Harness 插件：会话交接。用一次 LLM 摘要把整个会话后缀换成一份「交接单」，
机制等价于上下文压缩（`surfaceOp: replace`），但范围是整个后缀、文档面向人复核。

包目录 `plugins/handoff/`。P1 只提供 `/handoff` 命令（就地交接）；新会话交接与输入框按钮在 P2。

## 文档

完整文档（定位、流程、守卫、交接单格式、边界）在仓库里：

- [docs/plugins/handoff/README.md](../../docs/plugins/handoff/README.md)
- 架构与决策：[design.md](../../docs/plugins/handoff/design.md)

## 开发

```bash
npm run build -- --only handoff    # 生成 index.js / client.js（产物要提交）
npm run typecheck
npm test
```
