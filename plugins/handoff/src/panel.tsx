// 交接面板的展示层：纯 props（不订阅 store、不发请求），交互全部由 client.tsx 注入。
//
// 这样 tests/handoff/panel-render.test.ts 可以直接用 renderToStaticMarkup 断言文案、
// 选项与 disabled 状态，不需要 jsdom / 事件模拟。
import * as React from 'react';
import { pendingTextKey, type PanelStatus } from './logic.js';
import { Styles } from './styles.js';

export interface HandoffPanelViewProps {
  /** 翻译函数：由宿主随槽位下发（注册时声明了 `locale: NS`）。 */
  t: (key: string) => string;
  status: PanelStatus;
  onInPlace: () => void;
  onNewSession: () => void;
  onClose: () => void;
}

const INPLACE_ICON = (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3.5 8h11m0 0-3-3m3 3-3 3" />
    <path d="M20.5 16h-11m0 0 3-3m-3 3 3 3" />
  </svg>
);

const NEWSESSION_ICON = (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4.5 5.2h7.2l3 3v9.6H4.5z" />
    <path d="M11.7 5.2v3.2h3" />
    <path d="M16.6 12.1h4.3m0 0-1.9-1.9m1.9 1.9-1.9 1.9" />
  </svg>
);

/** 面板正文：标题、两个选项、状态行。 */
export function HandoffPanelView({ t, status, onInPlace, onNewSession, onClose }: HandoffPanelViewProps): React.ReactElement {
  const busy = status.kind === 'pending';
  // 成功后面板会自动收起（就地交接留 1.6s 展示确认文案）；这段时间也锁住动作，避免重复交接。
  const locked = busy || status.kind === 'success';
  return (
    <React.Fragment>
      <Styles />
      {/* 透明 backdrop：只负责“点外部关闭” */}
      <div className="hpf-backdrop" role="presentation" onClick={onClose} />
      <div className="hpf-panel" role="dialog" aria-modal="false" aria-label={t('panel.title')} aria-busy={busy}>
        <header className="hpf-head">
          <span className="hpf-head-main">
            <span className="hpf-title">{t('panel.title')}</span>
            <span className="hpf-sub">{t('panel.subtitle')}</span>
          </span>
          <button
            type="button"
            className="hpf-close"
            title={t('panel.close')}
            aria-label={t('panel.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="hpf-options">
          <button type="button" className="hpf-option" data-action="inplace" disabled={locked} onClick={onInPlace}>
            <span className="hpf-option-icon" aria-hidden="true">
              {INPLACE_ICON}
            </span>
            <span className="hpf-option-main">
              <span className="hpf-option-title">{t('option.inplace.title')}</span>
              <span className="hpf-option-desc">{t('option.inplace.desc')}</span>
            </span>
          </button>
          <button type="button" className="hpf-option" data-action="newsession" disabled={locked} onClick={onNewSession}>
            <span className="hpf-option-icon" aria-hidden="true">
              {NEWSESSION_ICON}
            </span>
            <span className="hpf-option-main">
              <span className="hpf-option-title">{t('option.new.title')}</span>
              <span className="hpf-option-desc">{t('option.new.desc')}</span>
            </span>
          </button>
        </div>

        <StatusLine status={status} t={t} />
      </div>
    </React.Fragment>
  );
}

/** 状态行：idle 不占位；pending 带转圈；结果用 success/error 着色。 */
function StatusLine({ status, t }: { status: PanelStatus; t: (key: string) => string }): React.ReactElement | null {
  if (status.kind === 'idle') return null;
  if (status.kind === 'pending') {
    return (
      <div className="hpf-status" data-kind="pending" role="status" aria-live="polite">
        <span className="hpf-spinner" aria-hidden="true" />
        <span className="hpf-status-text">{t(pendingTextKey(status.action))}</span>
      </div>
    );
  }
  return (
    <div className="hpf-status" data-kind={status.kind} role="status" aria-live="polite">
      <span className="hpf-status-text">{status.text}</span>
    </div>
  );
}
