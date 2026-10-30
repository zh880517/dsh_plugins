// 插件样式：只用宿主主题 token（--dsw-*），明暗主题自动跟随。
// 以 <style> 元素随组件渲染，卸载即移除，不向 document 追加节点（与 aiworkflow 一致）。
import * as React from 'react';

export const css = `
/* 输入框工具行左侧的入口：与同行的「＋」同规格（28×28 圆形、图标 14） */
.hpf-btn{width:28px;height:28px;display:inline-grid;place-items:center;flex:none;padding:0;
  border:none;border-radius:50%;background:var(--dsw-specific-selector);
  color:var(--dsw-alias-label-secondary);font-family:inherit;cursor:pointer;
  transition:background .12s ease,color .12s ease}
.hpf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.hpf-btn:disabled{opacity:.5;cursor:default}
.hpf-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.hpf-btn svg{display:block}

/* 面板：贴着输入框上方居中；backdrop 透明，只负责接“点外部关闭” */
.hpf-backdrop{position:fixed;inset:0;z-index:80;background:transparent;pointer-events:auto}
.hpf-panel{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:81;
  width:min(380px,calc(100vw - 24px));max-height:min(72vh,560px);overflow-y:auto;
  display:flex;flex-direction:column;gap:10px;padding:14px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-panel);font-family:inherit;
  font-size:13px;line-height:1.5;pointer-events:auto;
  box-shadow:var(--dsw-elevation-prominent)}
.hpf-panel::-webkit-scrollbar{width:8px}
.hpf-panel::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:8px}

.hpf-head{display:flex;align-items:flex-start;gap:8px}
.hpf-head-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.hpf-title{font-weight:600;font-size:13.5px;letter-spacing:.01em;word-break:break-word}
.hpf-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.hpf-close{width:24px;height:24px;display:grid;place-items:center;flex:none;padding:0;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.hpf-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.hpf-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

.hpf-options{display:flex;flex-direction:column;gap:6px}
.hpf-option{display:flex;align-items:flex-start;gap:10px;width:100%;padding:10px 11px;
  text-align:left;font:inherit;color:inherit;cursor:pointer;
  background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  transition:background .12s ease,border-color .12s ease}
.hpf-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary)}
.hpf-option:disabled{opacity:.55;cursor:default}
.hpf-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.hpf-option-icon{display:grid;place-items:center;width:18px;height:18px;flex:none;margin-top:1px;
  color:var(--dsw-alias-label-secondary)}
.hpf-option:hover:not(:disabled) .hpf-option-icon{color:var(--dsw-alias-brand-primary)}
.hpf-option-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.hpf-option-title{font-size:13px;font-weight:600;word-break:break-word}
.hpf-option-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.45;word-break:break-word}

.hpf-status{display:flex;align-items:flex-start;gap:8px;padding-top:10px;
  border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.5;
  color:var(--dsw-alias-label-secondary);word-break:break-word}
.hpf-status[data-kind="success"]{color:var(--dsw-alias-state-success-primary)}
.hpf-status[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
.hpf-status-text{min-width:0;white-space:pre-wrap}
.hpf-spinner{width:13px;height:13px;flex:none;margin-top:2px;border-radius:50%;
  border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);
  animation:hpf-spin .8s linear infinite}
@keyframes hpf-spin{to{transform:rotate(360deg)}}
`;

export function Styles(): React.ReactElement {
  return <style>{css}</style>;
}
