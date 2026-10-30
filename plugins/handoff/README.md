# @handoff/dsh-plugin

DeepSeek Harness 插件：会话交接。用一次 LLM 摘要把整个会话后缀换成一份「交接单」，
机制等价于上下文压缩（`surfaceOp: replace`），但范围是整个后缀、文档面向人复核。

包目录 `plugins/handoff/`。提供 `/handoff` 命令，以及输入框左侧的「交接」按钮：
在当前会话交接（用交接单替换后缀，不可逆）或开启新会话交接（只读草稿，旧会话不动）。

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
