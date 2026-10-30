// 面板展示层的结构回归：两个选项、说明、进行中 / 成功 / 失败三种状态行。
//
// 用 renderToStaticMarkup（仓库已有手法，见 tests/aiworkflow/inspector-render.test.ts），
// 不引入 jsdom；交互（点击、Esc）在 client.tsx，纯逻辑已经由 client-logic.test.ts 覆盖。
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TEXTS } from '../../plugins/handoff/src/i18n.js';
import type { PanelStatus } from '../../plugins/handoff/src/logic.js';
import { HandoffPanelView } from '../../plugins/handoff/src/panel.js';

const noop = (): void => undefined;

function render(status: PanelStatus, locale: 'zh' | 'en' = 'zh'): string {
  const t = (key: string): string => TEXTS[locale][key] ?? key;
  return renderToStaticMarkup(
    React.createElement(HandoffPanelView, {
      t,
      status,
      onInPlace: noop,
      onNewSession: noop,
      onClose: noop,
    }),
  );
}

describe('交接面板', () => {
  it('idle：只露两个选项与各自一行说明，不占状态行', () => {
    const html = render({ kind: 'idle' });
    expect(html).toContain('会话交接');
    expect(html).toContain('在当前会话交接');
    expect(html).toContain('用交接单替换整个会话后缀，不可撤销（会先落盘备份）');
    expect(html).toContain('开启新会话交接');
    expect(html).toContain('把交接单带到新会话继续，旧会话原样保留');
    expect(html).not.toContain('class="hpf-status"');
    // 三个按钮（关闭 + 两个选项）都可点
    expect(html).not.toContain('disabled=""');
  });

  it('进行中：显示转圈与动作对应文案，两个选项 disabled、关闭按钮仍可点', () => {
    const html = render({ kind: 'pending', action: 'inplace' });
    expect(html).toContain('正在生成交接单并替换当前会话…');
    expect(html).toContain('hpf-spinner');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).toContain('aria-label="关闭"');

    const next = render({ kind: 'pending', action: 'newsession' });
    expect(next).toContain('正在生成交接单并开启新会话…');
  });

  it('失败：用 error 样式原样展示 Host 的中文文案', () => {
    const html = render({ kind: 'error', text: '当前有轮次正在运行或压缩正在进行，交接暂不可用。' });
    expect(html).toContain('class="hpf-status" data-kind="error"');
    expect(html).toContain('当前有轮次正在运行或压缩正在进行，交接暂不可用。');
  });

  it('无历史：info 行提示，不出现成功样式', () => {
    const html = render({ kind: 'info', text: '没有可交接的历史。先在这个会话里聊几轮再试。' });
    expect(html).toContain('class="hpf-status" data-kind="info"');
    expect(html).toContain('没有可交接的历史');
    expect(html).not.toContain('class="hpf-status" data-kind="success"');
  });

  it('成功：success 样式展示 Host 文案，动作锁住等自动收起', () => {
    const html = render({ kind: 'success', text: '已交接：备份在 ~/.dsh/handoff/session-x.md' });
    expect(html).toContain('class="hpf-status" data-kind="success"');
    expect(html).toContain('已交接：备份在 ~/.dsh/handoff/session-x.md');
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  it('英文界面使用英文文案', () => {
    const html = render({ kind: 'idle' }, 'en');
    expect(html).toContain('Hand off in this conversation');
    expect(html).toContain('Hand off to a new conversation');
    expect(html).not.toContain('在当前会话交接');
  });
});
