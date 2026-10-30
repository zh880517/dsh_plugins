// Client 纯逻辑：draft / command 返回值归一化 + 面板状态机判定（design.md §5）。
//
// 不碰 DOM / fetch：直接喂 Host 契约里的各种形状，断言“展示哪段文案、是否允许关闭、
// 能不能继续建新会话”。Host 文案（中文）必须原样透传。
import { describe, expect, it } from 'vitest';

import { TEXTS } from '../../plugins/handoff/src/i18n.js';
import {
  classifyCommand,
  classifyDraft,
  pendingTextKey,
  workspaceIdOf,
} from '../../plugins/handoff/src/logic.js';

const BUSY_TEXT = '当前有轮次正在运行或压缩正在进行，交接暂不可用。';

describe('classifyDraft：GET /handoff/draft 的响应归一化', () => {
  it('有历史：返回 doc 与被遮蔽节点数', () => {
    expect(classifyDraft(200, { ok: true, doc: '# 交接：T10\n\n## 下一步\n跑测试。', shadowable: 4 })).toEqual({
      kind: 'doc',
      doc: '# 交接：T10\n\n## 下一步\n跑测试。',
      shadowable: 4,
    });
  });

  it('无历史（doc=null / shadowable=0）是 empty，不是成功', () => {
    expect(classifyDraft(200, { ok: true, doc: null, shadowable: 0 })).toEqual({ kind: 'empty' });
  });

  it('doc 为空串或纯空白时绝不建新会话', () => {
    expect(classifyDraft(200, { ok: true, doc: '', shadowable: 3 })).toEqual({ kind: 'empty' });
    expect(classifyDraft(200, { ok: true, doc: '  \n\t ', shadowable: 3 })).toEqual({ kind: 'empty' });
    expect(classifyDraft(200, { ok: true, doc: '# x', shadowable: 0 })).toEqual({ kind: 'empty' });
  });

  it('失败：透传 Host 的中文 error.message', () => {
    expect(
      classifyDraft(409, { ok: false, error: { code: 'busy', message: BUSY_TEXT } }),
    ).toEqual({ kind: 'error', text: BUSY_TEXT });
    expect(
      classifyDraft(502, { ok: false, error: { code: 'summary-failed', message: '交接单生成失败（模型未返回有效内容），未执行。' } }),
    ).toEqual({ kind: 'error', text: '交接单生成失败（模型未返回有效内容），未执行。' });
  });

  it('失败但没有 message：返回 null 交给插件兜底', () => {
    expect(classifyDraft(500, { ok: false, error: { code: 'internal' } })).toEqual({ kind: 'error', text: null });
  });

  it('200 但体不是契约形状（路由未落地 / HTML fallback）按失败处理', () => {
    expect(classifyDraft(200, '<!doctype html><html></html>')).toEqual({ kind: 'error', text: null });
    expect(classifyDraft(200, undefined)).toEqual({ kind: 'error', text: null });
    expect(classifyDraft(200, { ok: false })).toEqual({ kind: 'error', text: null });
  });
});

describe('classifyCommand：remote.commands.execute 的响应归一化', () => {
  it('成功：取 result.text', () => {
    expect(
      classifyCommand({ ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '已交接。' } } }),
    ).toEqual({ kind: 'success', text: '已交接。' });
  });

  it('成功但没有文案：text 为 null（UI 用“交接完成”）', () => {
    expect(classifyCommand({ ok: true, value: { commandId: 'c1', result: { kind: 'success' } } })).toEqual({
      kind: 'success',
      text: null,
    });
  });

  it('命令自身报错（busy / 无历史等）：透传中文 text', () => {
    expect(
      classifyCommand({ ok: true, value: { commandId: 'c1', result: { kind: 'error', text: BUSY_TEXT } } }),
    ).toEqual({ kind: 'error', text: BUSY_TEXT, reason: 'command' });
  });

  it('未知命令（value === undefined）与 RPC 失败都收敛为失败，并保留兜底原因', () => {
    expect(classifyCommand({ ok: true, value: undefined })).toEqual({
      kind: 'error',
      text: null,
      reason: 'unknown-command',
    });
    expect(classifyCommand({ ok: false, error: { code: 'session-not-found', message: '找不到会话。' } })).toEqual({
      kind: 'error',
      text: '找不到会话。',
      reason: 'command',
    });
    expect(classifyCommand({ ok: false, error: { code: 'internal' } })).toEqual({
      kind: 'error',
      text: null,
      reason: 'command',
    });
  });

  it('不认识的形状不会抛异常', () => {
    expect(classifyCommand(undefined)).toEqual({ kind: 'error', text: null, reason: 'transport' });
    expect(classifyCommand({ ok: true, value: {} })).toEqual({ kind: 'error', text: null, reason: 'transport' });
    expect(classifyCommand({ ok: true, value: { result: { kind: 'mystery', text: 'x' } } })).toEqual({
      kind: 'error',
      text: 'x',
      reason: 'command',
    });
  });
});

describe('workspaceIdOf：当前会话所属工作区', () => {
  // 真实形状：宿主 workspaces 列表快照 `{ items: [{ workspaceId, title, path, sessionIds }] }`
  const state = {
    items: [
      { workspaceId: 'ws-a', title: 'A', path: 'D:/a', sessionIds: ['s-1', 's-2'] },
      { workspaceId: 'ws-b', title: 'B', path: 'D:/b', sessionIds: ['s-3'] },
    ],
  };

  it('按 sessionIds 找到所属工作区的 workspaceId', () => {
    expect(workspaceIdOf(state, 's-3')).toBe('ws-b');
    expect(workspaceIdOf(state, 's-1')).toBe('ws-a');
  });

  it('会话不在任何工作区 / 形状不对：返回 undefined（调用方退回 cwd）', () => {
    expect(workspaceIdOf(state, 's-ungrouped')).toBeUndefined();
    expect(workspaceIdOf(state, '')).toBeUndefined();
    expect(workspaceIdOf(undefined, 's-1')).toBeUndefined();
    expect(workspaceIdOf({}, 's-1')).toBeUndefined();
    expect(workspaceIdOf({ items: 'nope' }, 's-1')).toBeUndefined();
    expect(workspaceIdOf({ items: [{ sessionIds: ['s-1'] }] }, 's-1')).toBeUndefined();
  });
});

describe('面板状态机', () => {
  it('两个动作的进行中文案各自独立', () => {
    expect(pendingTextKey('inplace')).toBe('status.pending.inplace');
    expect(pendingTextKey('newsession')).toBe('status.pending.new');
  });
});

describe('i18n 字典', () => {
  it('中英 key 完全对齐，且没有空文案', () => {
    const zh = Object.keys(TEXTS.zh).sort();
    const en = Object.keys(TEXTS.en).sort();
    expect(en).toEqual(zh);
    for (const key of zh) {
      expect(TEXTS.zh[key]?.trim()).not.toBe('');
      expect(TEXTS.en[key]?.trim()).not.toBe('');
    }
  });

  it('按钮文字是短标签（渲染在图标旁，不能写成长句）', () => {
    expect(TEXTS.zh['button.label']).toBe('交接');
    expect(TEXTS.en['button.label']).toBe('Handoff');
  });

  it('面板两套选项与结果文案齐全', () => {
    for (const key of [
      'button.label',
      'button.tooltip',
      'panel.title',
      'panel.subtitle',
      'option.inplace.title',
      'option.inplace.desc',
      'option.new.title',
      'option.new.desc',
      'status.pending.inplace',
      'status.pending.new',
      'status.noHistory',
      'error.network',
      'error.noCwd',
    ]) {
      expect(TEXTS.zh[key], key).toBeTypeOf('string');
    }
  });
});
