// Client 半入口：输入框工具行左侧的「交接」胶囊按钮（图标 + 文字）+ 一个两项面板。
//
// 为什么是按钮：用户不该为了交接去记 `/handoff`。按钮只做入口，真正的动作有两条：
//   1. 就地交接：`remote.commands.execute(sessionId, '/handoff', [])`。和斜杠菜单走同一条
//      Host 通道（宿主自己的 ui-plan 按钮也是这么调的），不写 composer、不 submit。
//   2. 新会话交接：`GET /handoff/draft` 拿只读交接单 → `sessions.create({ workspaceId })`
//      建新会话（宿主用 `workspace.path` 当 cwd 并 `attachSession`；没有工作区才退回
//      `{ cwd }`）→ 用 `sessions.using(...)` 借一个已 retain 的会话句柄，把交接单作为
//      首条 prompt 发进去（`sessionManager.create` **没有** prompt 字段，`ctx.sessions.create`
//      也不接受 prompt）→ `uiWorkspace.openSession(newId)` 切过去；旧会话一个字节都不动。
//
// 面板状态（idle / pending / 结果）留在组件里；跨组件的只有“面板是否打开 + 目标会话”。
// 纯逻辑见 logic.ts（可单测），展示层见 panel.tsx（可静态渲染）。
import * as React from 'react';

import { resolveEndpoint } from './endpoint.js';
import { handoffInPlace, handoffToNewSession } from './actions.js';
import { NS, registerTexts, type Translate } from './i18n.js';
import { type PanelStatus, workspaceIdOf } from './logic.js';
import { HandoffPanelView } from './panel.js';
import { Styles } from './styles.js';

export const inject = ['slots', 'locale', 'remote', 'remote.commands', 'sessions', 'uiWorkspace'];

const INPUT_LEFT_SLOT = 'conversation.input.left';
const OVERLAY_SLOT = 'shell.overlay';
const ENTRY_ID = 'handoff';
const PANEL_ID = 'handoff-panel';

// ---- 跨组件的面板开关 ------------------------------------------------------

interface PanelTarget {
  readonly open: boolean;
  readonly sessionId: string;
  readonly cwd: string | undefined;
  readonly workspaceId: string | undefined;
}

const CLOSED: PanelTarget = Object.freeze({
  open: false,
  sessionId: '',
  cwd: undefined,
  workspaceId: undefined,
});

let snapshot: PanelTarget = CLOSED;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

const panelTarget = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): PanelTarget {
    return snapshot;
  },
  open(sessionId: string, cwd: string | undefined, workspaceId: string | undefined): void {
    if (snapshot.open && snapshot.sessionId === sessionId) return;
    snapshot = Object.freeze({ open: true, sessionId, cwd, workspaceId });
    emit();
  },
  close(): void {
    if (!snapshot.open) return;
    snapshot = CLOSED;
    emit();
  },
};

// ---- 入口按钮 --------------------------------------------------------------

function HandoffIcon(): React.ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 交接单本身 */}
      <path d="M5 4.4h8.2a1.7 1.7 0 0 1 1.7 1.7v12a1.7 1.7 0 0 1-1.7 1.7H5a1.7 1.7 0 0 1-1.7-1.7V6.1A1.7 1.7 0 0 1 5 4.4Z" />
      {/* 文档里的两条内容线 */}
      <path d="M6.5 9.3h4.2M6.5 12.6h2.8" />
      {/* 交出去 */}
      <path d="M16 12h5.4M18.9 9.5 21.7 12l-2.8 2.5" />
    </svg>
  );
}

/**
 * 输入框左侧的胶囊按钮（`conversation.input.left`）：图标旁边带「交接」短标签。
 *
 * 新会话必须落在**当前会话所属的工作区**里：宿主 `session.create` 只有在收到
 * `workspaceId` 时才 `attachSession`，只给 cwd 建出来的会话不属于任何工作区，
 * 侧栏会把它丢进 Ungrouped（重启也不会自愈，成员关系是持久化的）。
 *
 * `t` 来自槽位下发（注册时声明了 `locale: NS`），这样面板开着切语言会跟着重渲染。
 */
function HandoffButton(props: Record<string, unknown>): React.ReactElement {
  const t = typeof props['t'] === 'function' ? (props['t'] as Translate) : (key: string): string => key;
  const sessionId = typeof props['sessionId'] === 'string' ? props['sessionId'] : '';
  // 当前会话的 cwd：工作区取不到时兜底（宿主用 cwd 建会话，只是不挂工作区）。
  const cwd =
    typeof props['useSessions'] === 'function'
      ? (props['useSessions'] as (selector: (state: unknown) => unknown) => unknown)((state: unknown) => {
          if (sessionId === '') return undefined;
          const list = state as { byId?: Record<string, { cwd?: unknown } | undefined> } | undefined;
          const value = list?.byId?.[sessionId]?.cwd;
          return typeof value === 'string' ? value : undefined;
        })
      : undefined;
  // 宿主 workspaces 快照：`items[].sessionIds` 里有当前会话的那一项就是它的工作区。
  const workspaceId =
    typeof props['useWorkspaces'] === 'function'
      ? (props['useWorkspaces'] as (selector: (state: unknown) => unknown) => unknown)((state: unknown) =>
          workspaceIdOf(state, sessionId),
        )
      : undefined;

  const onClick = (): void => {
    panelTarget.open(
      sessionId,
      typeof cwd === 'string' ? cwd : undefined,
      typeof workspaceId === 'string' ? workspaceId : undefined,
    );
  };

  return (
    <React.Fragment>
      {/* 按钮与面板各自带一份样式；面板没打开时也不会裸样式 */}
      <Styles />
      <button
        type="button"
        className="hpf-btn"
        title={t('button.tooltip')}
        aria-label={t('button.label')}
        aria-haspopup="dialog"
        onClick={onClick}
      >
        <HandoffIcon />
        <span className="hpf-btn-label">{t('button.label')}</span>
      </button>
    </React.Fragment>
  );
}

// ---- 面板容器 --------------------------------------------------------------

/** 错误详情：只有 Error 的 message 值得展示；其它一律留空给兜底文案。 */
function abortDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : '';
}

/** 读取 draft：JSON 解析失败当成“没有 body”，由 classifyDraft 按失败处理。 */
async function readDraft(sessionId: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const response = await fetch(resolveEndpoint(`handoff/draft?session=${encodeURIComponent(sessionId)}`), {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/** 面板容器：订阅开关、发请求、维护 pending / 结果状态。 */
function HandoffPanel({ ctx, t }: { ctx: any; t: Translate }): React.ReactElement | null {
  const target = React.useSyncExternalStore(
    panelTarget.subscribe,
    panelTarget.getSnapshot,
    panelTarget.getSnapshot,
  );
  const [status, setStatus] = React.useState<PanelStatus>({ kind: 'idle' });

  const alive = React.useRef(true);
  // 同步的“正在跑”闸门：setStatus 要等下一次渲染，两个快速点击会在渲染前都进来。
  const inFlight = React.useRef(false);
  const abort = React.useRef<AbortController | null>(null);
  const closeTimer = React.useRef<number | undefined>(undefined);

  React.useEffect(
    () => () => {
      alive.current = false;
      abort.current?.abort();
      abort.current = null;
      if (closeTimer.current !== undefined) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = undefined;
      }
    },
    [],
  );

  // 每次重新打开都从 idle 开始；同时清掉上一次就地交接遗留的自动关闭定时器。
  // 例外：上一次动作还在飞（关掉面板并不取消就地命令）时保留 pending，重新打开能看见。
  React.useEffect(() => {
    if (target.open && !inFlight.current) setStatus({ kind: 'idle' });
    return () => {
      if (closeTimer.current !== undefined) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = undefined;
      }
    };
  }, [target.open]);

  // 关闭时取消还在飞的 draft 请求（Host 会在客户端断开时中止摘要）。
  React.useEffect(() => {
    if (!target.open) {
      abort.current?.abort();
      abort.current = null;
    }
  }, [target.open]);

  // Esc 关闭；动作进行中也可以关，只是 draft 请求会被取消。
  React.useEffect(() => {
    if (!target.open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      panelTarget.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target.open]);

  const close = (): void => {
    panelTarget.close();
  };

  /** 就地交接：走和斜杠菜单同一条 Host 命令通道，把结果文案放回面板。 */
  const runInPlace = async (): Promise<void> => {
    if (inFlight.current || !target.open) return;
    const sessionId = target.sessionId;
    if (sessionId === '') {
      setStatus({ kind: 'error', text: t('error.unknown') });
      return;
    }
    inFlight.current = true;
    setStatus({ kind: 'pending', action: 'inplace' });
    try {
      const outcome = await handoffInPlace({ commands: ctx.remote.commands }, sessionId);
      if (!alive.current) return;
      if (outcome.kind === 'success') {
        // Host 的成功文案是中文，原样展示；没有文案就用自己的“交接完成”。
        setStatus({ kind: 'success', text: outcome.text ?? t('status.done') });
        // 成功后就地交接已经生效；留 1.6s 让人看见确认文案，然后自动收起。
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = undefined;
          if (alive.current) panelTarget.close();
        }, 1600);
        return;
      }
      setStatus({
        kind: 'error',
        text:
          outcome.text ??
          (outcome.reason === 'unknown-command' ? t('error.unknownCommand') : t('error.unknown')),
      });
    } finally {
      inFlight.current = false;
    }
  };

  /** 新会话交接：draft → create → prompt → openSession。旧会话不动。 */
  const runNewSession = async (): Promise<void> => {
    if (inFlight.current || !target.open) return;
    const { sessionId, cwd, workspaceId } = target;
    if (sessionId === '') {
      setStatus({ kind: 'error', text: t('error.unknown') });
      return;
    }
    if ((workspaceId === undefined || workspaceId === '') && (cwd === undefined || cwd === '')) {
      setStatus({ kind: 'error', text: t('error.noCwd') });
      return;
    }
    inFlight.current = true;
    setStatus({ kind: 'pending', action: 'newsession' });
    const controller = new AbortController();
    abort.current = controller;
    try {
      const outcome = await handoffToNewSession(
        { sessions: ctx.sessions, uiWorkspace: ctx.uiWorkspace, readDraft },
        sessionId,
        { cwd, workspaceId },
        controller.signal,
      );
      if (!alive.current) return;

      if (outcome.kind === 'empty') {
        // 没有可交接的历史：不建新会话，停在原会话。
        setStatus({ kind: 'info', text: t('status.noHistory') });
        return;
      }
      if (outcome.kind === 'cancelled') {
        // 面板在 prompt 发出之前关掉了：请求已取消，把状态还原，下次打开从 idle 开始。
        setStatus({ kind: 'idle' });
        return;
      }
      if (outcome.kind === 'moved') {
        // 成功（即使 signal 是在 prompt 之后才 abort 的）：已经切到新会话，收起面板。
        panelTarget.close();
        return;
      }

      switch (outcome.stage) {
        case 'cwd':
          setStatus({ kind: 'error', text: t('error.noCwd') });
          return;
        case 'draft':
          setStatus({
            kind: 'error',
            // 有 HTTP 状态 = Host 明确拒绝（展示它的中文原因）；没有 = 网络层失败。
            text:
              outcome.status === undefined
                ? t('error.network')
                : (outcome.text ?? `${t('error.draft')} HTTP ${outcome.status}`),
          });
          return;
        case 'prompt':
          setStatus({ kind: 'error', text: outcome.text ?? t('error.prompt') });
          return;
        case 'create':
        default:
          setStatus({ kind: 'error', text: outcome.text ?? t('error.unknown') });
          return;
      }
    } catch (cause) {
      if (!alive.current) return;
      const detail = abortDetail(cause);
      setStatus({ kind: 'error', text: detail === '' ? t('error.unknown') : `${t('error.unknown')} ${detail}` });
    } finally {
      if (abort.current === controller) abort.current = null;
      inFlight.current = false;
    }
  };

  if (!target.open) return null;

  return (
    <HandoffPanelView
      t={t}
      status={status}
      onInPlace={() => void runInPlace()}
      onNewSession={() => void runNewSession()}
      onClose={close}
    />
  );
}

// ---- 插件入口 --------------------------------------------------------------

export function apply(ctx: any): void {
  const disposeTexts = registerTexts(ctx);

  ctx.effect(() => disposeTexts);
  // 插件卸载（或 HMR 重载）时别把面板留在打开状态。
  ctx.effect(() => () => panelTarget.close());

  ctx.effect(() =>
    ctx.slots.inject(INPUT_LEFT_SLOT, () =>
      ctx.slots.register(
        { name: INPUT_LEFT_SLOT, id: ENTRY_ID, order: 30, locale: NS },
        (props: Record<string, unknown>) => <HandoffButton {...props} />,
      ),
    ),
  );

  // 面板放在全帧 overlay：输入框工具行空间太小，浮层也不会被工具栏的 overflow 裁掉。
  // `locale: NS` 让宿主下发绑定到本插件命名空间的 `t`，切语言时会重渲染。
  ctx.effect(() =>
    ctx.slots.inject(OVERLAY_SLOT, () =>
      ctx.slots.register(
        { name: OVERLAY_SLOT, id: PANEL_ID, order: 80, locale: NS },
        (props: Record<string, unknown>) => (
          <HandoffPanel
            ctx={ctx}
            t={typeof props['t'] === 'function' ? (props['t'] as Translate) : (key: string): string => key}
          />
        ),
      ),
    ),
  );
}
