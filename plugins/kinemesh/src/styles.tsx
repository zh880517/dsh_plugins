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
  color:var(--dsw-alias-label-on-color,#111)}
.kinemesh-btn[data-primary="true"]:hover{filter:brightness(1.06)}

/* 3D 舞台：0.7.0 起撑满剩余高度（原先写死 min(58vh,540px) 只占半屏）。
   flex-basis 给一个视口兜底值，flex-grow 再吃掉剩余空间：
   · 宿主容器高度确定时 → 长到满（真正铺满页面）；
   · 万一父容器高度是 auto（flex 链断掉）→ 也不会塌成一条，至少 min(46vh,420px)。 */
.kinemesh-stage{position:relative;margin:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;
  overflow:hidden;background:var(--dsw-alias-bg-layer-1);flex:1 1 min(46vh,420px);min-height:0}
.kinemesh-stage canvas{display:block;width:100%;height:100%}
.kinemesh-stage[data-dragover="true"]{border-color:var(--dsw-alias-brand-primary);border-style:dashed}
.kinemesh-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;
  align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);
  font-size:12.5px;text-align:center;padding:0 24px;pointer-events:none}
.kinemesh-dropzone-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.kinemesh-dropmask{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);
  color:var(--dsw-alias-brand-primary);font-size:13px;font-weight:600}

/* ———— 播放条（0.7.0：纯图标按钮，整条在轨道条上方，居中排布） ———— */
.kinemesh-transport{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 14px 4px}
.kinemesh-transportbtn{width:30px;height:30px;border-radius:8px}
.kinemesh-transportbtn[disabled]{opacity:.35;cursor:default}
.kinemesh-transportbtn[disabled]:hover{background:transparent;color:var(--dsw-alias-label-secondary)}

.kinemesh-readout{display:flex;align-items:center;gap:8px;padding:4px 14px 8px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex-wrap:wrap}
.kinemesh-chip{padding:2px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1)}

.kinemesh-banner{margin:6px 14px;padding:8px 10px;border-radius:10px;font-size:12px;
  border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.kinemesh-banner[data-kind="ok"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}

.kinemesh-foot{display:flex;align-items:center;gap:10px;padding:10px 14px 14px}

/* ———— 独立预览页（侧边栏入口，0.6.0：纯预览不接 AI） ———— */
/* 0.7.0：整页不再滚动，3D 舞台吃掉除工具栏/播放条/轨道以外的全部高度 */
.kinemesh-standalone{display:flex;flex-direction:column;width:100%;height:100%;min-height:360px;overflow:hidden;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;font-family:inherit}
.kinemesh-standalonehead{display:flex;align-items:baseline;gap:8px;padding:14px 18px 4px;flex:none}
.kinemesh-standalonemain{flex:1;min-height:0;display:flex;flex-direction:column;padding-bottom:12px}
.kinemesh-standalonemain .kinemesh-stage{margin:0 18px}
.kinemesh-standalonemain .kinemesh-toolbar,
.kinemesh-standalonemain .kinemesh-transport,
.kinemesh-standalonemain .kinemesh-readout{padding-left:18px;padding-right:18px}
.kinemesh-standalonemain .kinemesh-timeline{margin-left:18px;margin-right:18px}

/* ———— 模型预览页（conversation.view 页签，M6e） ———— */
.kinemesh-page{display:flex;width:100%;height:100%;min-height:420px;overflow:hidden;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;font-family:inherit}.kinemesh-pageholder{flex:1;display:grid;place-items:center;padding:24px;text-align:center;
  color:var(--dsw-alias-label-secondary);font-size:12.5px}
.kinemesh-side{width:250px;min-width:200px;flex:none;display:flex;flex-direction:column;
  border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.kinemesh-sidehead{padding:10px 12px 6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.kinemesh-sideitems{flex:1;overflow:auto;padding:0 8px;display:flex;flex-direction:column;gap:2px}
.kinemesh-sideitem{display:flex;align-items:center;gap:6px;width:100%;padding:7px 8px;border-radius:8px;
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;cursor:pointer;text-align:left;overflow:hidden}
.kinemesh-sideitem:hover{background:var(--dsw-alias-bg-layer-2)}
.kinemesh-sideitem[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.kinemesh-sidename{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kinemesh-badge{flex:none;padding:1px 6px;border-radius:6px;font-size:10.5px;
  border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.kinemesh-sideempty{padding:12px;color:var(--dsw-alias-label-secondary);font-size:11.5px;text-align:center}
.kinemesh-sidefoot{display:flex;align-items:center;gap:6px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.kinemesh-sidefoot .kinemesh-input{min-width:0;flex:1}
.kinemesh-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}

/* ———— 强度曲线轨道条（§6.10.3）：0.7.0 起拖动与帧号都收在这条轨道里 ———— */
.kinemesh-timeline{margin:4px 14px 0}
.kinemesh-timelinehead{display:flex;align-items:baseline;gap:10px;margin-bottom:3px}
.kinemesh-timelinehead .kinemesh-timelinehint{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.kinemesh-framelabel{flex:none;font-size:11.5px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary);padding:1px 7px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1)}
.kinemesh-timeline svg{display:block;width:100%;height:52px;cursor:crosshair;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);touch-action:none}
.kinemesh-ticks{position:relative;height:14px;margin-top:2px}
.kinemesh-tick{position:absolute;top:0;font-size:10px;line-height:14px;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
`;

export function Styles(): React.ReactElement {
  return <style>{css}</style>;
}
