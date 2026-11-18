// 插件样式：只使用宿主主题 token（--dsw-alias-*），明暗主题自动跟随。
// 以 <style> 元素随组件渲染，卸载即移除，不向 document 追加节点。类名统一 kinemesh- 前缀。
import * as React from 'react';

export const css = `
.kinemesh-launchbtn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);
  font-size:12px;font-family:inherit;cursor:pointer;transition:background .12s ease,color .12s ease}
.kinemesh-launchbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}

.kinemesh-backdrop{position:fixed;inset:0;background:rgba(9,12,16,.42);z-index:80;display:grid;place-items:center}
.kinemesh-dialog{width:min(860px,94vw);max-height:min(88vh,900px);display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-family:inherit;
  border:1px solid var(--dsw-alias-border-l1);border-radius:16px;overflow:hidden;font-size:13px;line-height:1.5;
  box-shadow:0 24px 60px rgba(9,12,16,.35)}
.kinemesh-head{display:flex;align-items:center;gap:8px;padding:12px 14px 8px}
.kinemesh-title{font-weight:600;font-size:13px}
.kinemesh-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.kinemesh-spacer{flex:1}
.kinemesh-iconbtn{width:26px;height:26px;display:grid;place-items:center;border-radius:8px;border:1px solid transparent;
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;font-family:inherit}
.kinemesh-iconbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}

.kinemesh-toolbar{display:flex;align-items:center;gap:8px;padding:8px 14px;flex-wrap:wrap}
.kinemesh-input{flex:1;min-width:220px;height:28px;padding:0 10px;border-radius:8px;font:inherit;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.kinemesh-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.kinemesh-select{height:28px;padding:0 8px;border-radius:8px;font:inherit;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.kinemesh-btn{height:28px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.kinemesh-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.kinemesh-btn[disabled]{opacity:.55;cursor:default}
.kinemesh-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:var(--dsw-alias-label-on-brand,#fff)}
.kinemesh-btn[data-primary="true"]:hover{filter:brightness(1.06)}

.kinemesh-stage{position:relative;margin:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
  overflow:hidden;background:#23262b}
.kinemesh-stage canvas{display:block;width:100%;height:auto}
.kinemesh-placeholder{height:420px;display:grid;place-items:center;color:var(--dsw-alias-label-secondary);
  font-size:12.5px;text-align:center;padding:0 24px}

.kinemesh-controls{display:flex;align-items:center;gap:10px;padding:10px 14px 4px}
.kinemesh-slider{flex:1;accent-color:var(--dsw-alias-brand-primary)}
.kinemesh-frame{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);min-width:86px;text-align:right}

.kinemesh-readout{display:flex;align-items:center;gap:8px;padding:4px 14px 8px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex-wrap:wrap}
.kinemesh-chip{padding:2px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1)}

.kinemesh-banner{margin:6px 14px;padding:8px 10px;border-radius:10px;font-size:12px;
  border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.kinemesh-banner[data-kind="ok"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}

.kinemesh-foot{display:flex;align-items:center;gap:10px;padding:10px 14px 14px}
`;

export function Styles(): React.ReactElement {
  return <style>{css}</style>;
}
