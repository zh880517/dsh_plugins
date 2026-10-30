// Client 半入口（P1 空实现）。
//
// 构建脚本要求 `src/client.tsx` 存在并导出 `apply()`：P1 还没有界面，所以这里
// 什么都不注册；P2 会在这里 `inject: ['slots', 'locale']`，往
// `conversation.input.left` 挂「交接」菜单（design.md §5）。

export function apply(_ctx: unknown): void {
  // P2: 注册交接菜单（就地 / 新会话两项）与 locale 文本。
}
