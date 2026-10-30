// 面板纯逻辑：把 Host 的两类返回收敛成显式结果。
//
// 刻意不 import React、不碰 DOM / fetch —— tests/handoff/client-logic.test.ts 直接喂
// 各种形状的返回值断言映射。Host 文案一律原样透传（中文），插件只在 Host 没给文案时
// 返回 `null`，由 UI 补自己的兜底文案。

/** 面板里的两个动作。 */
export type HandoffAction = 'inplace' | 'newsession';

/** 面板状态：idle / 进行中 / 结果。结果只保留要展示的一行文字。 */
export type PanelStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly action: HandoffAction }
  | { readonly kind: 'info'; readonly text: string }
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

/** `GET /handoff/draft` 的归一化结果。 */
export type DraftOutcome =
  | { readonly kind: 'doc'; readonly doc: string; readonly shadowable: number }
  | { readonly kind: 'empty' }
  /** `text` 是 Host 的中文失败原因；`null` 表示 Host 没给，需要插件兜底。 */
  | { readonly kind: 'error'; readonly text: string | null };

/** `remote.commands.execute('/handoff')` 的归一化结果。 */
export type CommandOutcome =
  | { readonly kind: 'success'; readonly text: string | null }
  | {
      readonly kind: 'error';
      readonly text: string | null;
      /** 没有 Host 文案时，用哪条兜底文案：未知命令 / 命令失败 / 通道失败。 */
      readonly reason: 'unknown-command' | 'command' | 'transport';
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** 取一个非空字符串字段；类型不对 / 空串都算没有。 */
function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  if (record === undefined) return null;
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 归一化 draft 响应（契约见 `src/draft.ts` 的 `HandoffDraftBody`）。
 *
 * - 2xx + `{ ok: true, doc, shadowable }`：有历史 → `doc`；`doc === null` / 空串 /
 *   `shadowable <= 0` → `empty`（**绝不能**拿空文本去建新会话）。
 * - 非 2xx：`{ ok: false, error: { message } }` → 透传中文 message。
 * - 200 但体不是契约形状（例如路由未落地时被 SPA fallback 成 HTML）：按失败处理。
 */
export function classifyDraft(status: number, body: unknown): DraftOutcome {
  const record = asRecord(body);
  if (status < 200 || status >= 300) {
    return { kind: 'error', text: stringField(asRecord(record?.['error']), 'message') };
  }
  if (record === undefined || record['ok'] !== true) {
    return { kind: 'error', text: stringField(asRecord(record?.['error']), 'message') };
  }
  const doc = record['doc'];
  const shadowable = typeof record['shadowable'] === 'number' ? record['shadowable'] : 0;
  if (typeof doc !== 'string' || doc.trim() === '' || shadowable <= 0) return { kind: 'empty' };
  return { kind: 'doc', doc, shadowable };
}

/**
 * 归一化 `commands.execute` 的结果。
 *
 * 真实形状：`{ ok: true, value: { commandId, result: { kind, text? } } } |
 * { ok: false, error: { message } }`；`value === undefined` 表示未知命令（本插件理论上
 * 不会发生，但宿主契约允许）。任何不认识的形状都收敛成“失败 + 无文案”。
 */
export function classifyCommand(result: unknown): CommandOutcome {
  const record = asRecord(result);
  if (record === undefined) return { kind: 'error', text: null, reason: 'transport' };
  if (record['ok'] === false) {
    return { kind: 'error', text: stringField(asRecord(record['error']), 'message'), reason: 'command' };
  }
  if (record['ok'] !== true) return { kind: 'error', text: null, reason: 'transport' };

  const value = record['value'];
  if (value === undefined) return { kind: 'error', text: null, reason: 'unknown-command' };
  const outcome = asRecord(asRecord(value)?.['result']);
  if (outcome === undefined) return { kind: 'error', text: null, reason: 'transport' };

  const text = stringField(outcome, 'text');
  return outcome['kind'] === 'success'
    ? { kind: 'success', text }
    : { kind: 'error', text, reason: 'command' };
}

/** 进行中那一行文案对应的 i18n key。 */
export function pendingTextKey(action: HandoffAction): string {
  return action === 'inplace' ? 'status.pending.inplace' : 'status.pending.new';
}

/**
 * 从宿主 `useWorkspaces` 的状态里找某个会话所属的工作区。
 *
 * 真实形状（`dsh-client-ui-workspace` 的 workspaces 列表快照）：
 * `{ items: [{ workspaceId, title, path, sessionIds }] }`。会话可能不在任何工作区
 * （Ungrouped），这时返回 `undefined`，调用方退回 cwd。
 *
 * @param state - `useWorkspaces((s) => s)` 拿到的整份状态（形状不对按没有处理）。
 * @param sessionId - 当前会话 id。
 * @returns 所属工作区的 `workspaceId`；没有就 `undefined`。
 */
export function workspaceIdOf(state: unknown, sessionId: string): string | undefined {
  if (sessionId === '') return undefined;
  const items = (state as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    const record = asRecord(item);
    const members = record?.['sessionIds'];
    if (!Array.isArray(members) || !members.includes(sessionId)) continue;
    const workspaceId = record?.['workspaceId'];
    return typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : undefined;
  }
  return undefined;
}
