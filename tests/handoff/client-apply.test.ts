// Client 入口接线的冒烟测试：不连真 DSH，用假 ctx 断言槽位注册、注入的服务、
// 按钮渲染与“面板关闭时不渲染”的行为。交互逻辑由 client-logic.test.ts 覆盖。
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { apply, inject } from '../../plugins/handoff/src/client.js';
import { TEXTS, type Translate } from '../../plugins/handoff/src/i18n.js';

/** 宿主下发的 `t`（注册槽位时声明 `locale: NS` 后由槽位框架注入）。 */
const t: Translate = (key) => TEXTS.zh[key] ?? key;

interface Registration {
  readonly def: Record<string, unknown>;
  readonly component: (props: Record<string, unknown>) => React.ReactElement | null;
}

/** 记下 apply() 注册的槽位条目；effect 立即执行（与 Cordis 一致）。 */
function harness(): { ctx: any; registrations: Registration[] } {
  const registrations: Registration[] = [];
  const ctx = {
    locale: {
      register: () => (): void => undefined,
      bind: () => (key: string): string => key,
    },
    effect: (factory: () => unknown): unknown => factory(),
    slots: {
      inject: (_name: string, factory: () => () => void): (() => void) => factory(),
      register: (def: Record<string, unknown>, component: (props: Record<string, unknown>) => React.ReactElement | null) => {
        registrations.push({ def, component });
        return (): void => undefined;
      },
    },
    remote: { commands: { execute: async () => ({ ok: true, value: { commandId: 'c', result: { kind: 'success' } } }) } },
    sessions: {
      create: async () => 'session-new',
      using: async (_id: string, _options: unknown, operation: (reference: unknown) => unknown) =>
        operation({ binding: { session: { prompt: async () => ({ ok: true }) } } }),
    },
    uiWorkspace: { openSession: () => undefined },
  };
  return { ctx, registrations };
}

describe('客户端接线', () => {
  it('注入 slot / locale / remote.commands / sessions / uiWorkspace', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.commands', 'sessions', 'uiWorkspace']);
  });

  it('在 conversation.input.left 注册「图标 + 文字」胶囊交接按钮（order 30）', () => {
    const { ctx, registrations } = harness();
    apply(ctx);

    const button = registrations.find((entry) => entry.def['name'] === 'conversation.input.left');
    expect(button).toBeDefined();
    expect(button?.def['id']).toBe('handoff');
    expect(button?.def['order']).toBe(30);
    expect(button?.def['locale']).toBe('handoff');

    const html = renderToStaticMarkup(
      React.createElement(button!.component, {
        sessionId: 'session-1',
        t,
        useSessions: (selector: (state: unknown) => unknown) =>
          selector({ byId: { 'session-1': { cwd: 'D:/GitHub/dsh_plugins' } } }),
        useWorkspaces: (selector: (state: unknown) => unknown) =>
          selector({ items: [{ workspaceId: 'ws-1', sessionIds: ['session-1'] }] }),
      }),
    );
    expect(html).toContain('class="hpf-btn"');
    expect(html).toContain('title="交接"');
    expect(html).toContain('aria-label="交接"');
    // 胶囊里必须同时有图标与短标签（用户反馈图标太小、意义不明）。
    expect(html).toContain('<svg');
    expect(html).toContain('width="18" height="18"');
    expect(html).toContain('class="hpf-btn-label"');
    expect(html).toContain('<span class="hpf-btn-label">交接</span>');
  });

  it('面板挂在 shell.overlay（locale 声明为 handoff）；关闭时不渲染任何可见节点', () => {
    const { ctx, registrations } = harness();
    apply(ctx);

    const panel = registrations.find((entry) => entry.def['name'] === 'shell.overlay');
    expect(panel).toBeDefined();
    expect(panel?.def['id']).toBe('handoff-panel');
    expect(panel?.def['locale']).toBe('handoff');
    expect(renderToStaticMarkup(React.createElement(panel!.component, { t }))).toBe('');
  });
});
