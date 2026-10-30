// Host 半入口：`/handoff` 命令的注册与生命周期。
//
// 形状照抄 `@deepseek-ai/dsh-command-compact`（design.md §4.1）：`active` 集合保证插件
// 卸载时等所有进行中的交接结算，命令注册放在 `ctx.effect` 里，随插件卸载一起撤销。
//
// 真正的执行体（守卫 → 摘要 → 备份 → 替换 → 文案）在 `command.ts`（T4）。

import { runHandoff, type HandoffCommandResult, type HandoffInvocation } from './command.js';

export type { HandoffCommandResult, HandoffInvocation };

export const inject = ['commands', 'sessions', 'llm'];

/**
 * 注册 `/handoff`，并在卸载时等待进行中的交接结算。
 * @param ctx - 宿主上下文（`commands` / `sessions` / `llm` 已注入）。
 */
export function apply(ctx: any): void {
  const active = new Set<Promise<unknown>>();
  const handler = (invocation: HandoffInvocation): Promise<HandoffCommandResult> => {
    const operation = runHandoff(ctx, invocation);
    active.add(operation);
    const retire = (): void => {
      active.delete(operation);
    };
    operation.then(retire, retire);
    return operation;
  };
  ctx.effect(function* () {
    yield async () => {
      await Promise.allSettled(active);
    };
    yield ctx.commands.register({
      // 与 DSH 自家命令一致（`@deepseek-ai/dsh-command-compact` 等用完整包名作
      // definitionId）；`name` 才是用户敲的 `/handoff`，两者不是一回事。
      definitionId: '@handoff/dsh-plugin',
      name: 'handoff',
      description: 'Replace this conversation with a handoff document',
      handler,
    });
  }, 'handoff lifecycle');
}
