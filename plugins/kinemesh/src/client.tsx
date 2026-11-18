// Client 半入口：输入框左侧「动析」入口 + 预览浮层（模型加载 / 转角度 / 拖帧 / 播放 / 模式切换 /
// 发送给 AI 分析）。预览用 core/viewer/kinemesh-viewer.ts（与 kinemesh_render 截图同一模块，构图一致）。
import * as React from 'react';
import { mountViewer, type ViewerHandle } from './core/viewer/kinemesh-viewer.js';
import { detectFormat } from './core/registry.js';
import { resolveEndpoint } from './endpoint.js';
import { Styles } from './styles.js';
import { RENDER_FPS, type ViewState, type ViewMode } from './core/viewstate.js';

export const inject = ['slots', 'locale'];

const INPUT_LEFT_SLOT = 'conversation.input.left';
const OVERLAY_SLOT = 'shell.overlay';
const ENTRY_ID = 'kinemesh-launcher';
const VIEW_MODES: ViewMode[] = ['default', 'wireframe', 'skeleton', 'bones-overlay'];

/** 点开入口时记下的会话连接（run/分析要绑到它） */
let connection: { sessionId: string; draft: string; actions: { setDraft?: (draft: string) => void } | null } | null = null;

const overlayStore = {
  listeners: new Set<() => void>(),
  open: false,
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  },
  getSnapshot(): boolean {
    return this.open;
  },
  set(next: boolean): void {
    if (this.open === next) return;
    this.open = next;
    for (const listener of this.listeners) listener();
  },
};

function LauncherButton(props: any): React.ReactElement {
  const draft =
    typeof props?.useInput === 'function'
      ? props.useInput((state: { draft?: string } | undefined) => state?.draft ?? '')
      : '';
  const onClick = (): void => {
    connection = {
      sessionId: typeof props?.sessionId === 'string' ? props.sessionId : '',
      draft: typeof draft === 'string' ? draft : '',
      actions: (props?.inputActions as { setDraft?: (draft: string) => void } | undefined) ?? null,
    };
    overlayStore.set(true);
  };
  return (
    <React.Fragment>
      <Styles />
      <button type="button" className="kinemesh-launchbtn" onClick={onClick} title="打开 3D 预览（动析）">
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.5 20 8l-8 4.5L4 8Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M4 8v8l8 4.5V12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M20 8v8l-8 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        <span>动析</span>
      </button>
    </React.Fragment>
  );
}

interface LoadState {
  phase: 'empty' | 'loading' | 'ready';
  error: string | null;
  clips: string[];
  maxFrame: number;
}

function PreviewDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [modelPath, setModelPath] = React.useState('');
  const [clip, setClip] = React.useState('');
  const [frame, setFrame] = React.useState(0);
  const [mode, setMode] = React.useState<ViewMode>('default');
  const [playing, setPlaying] = React.useState(false);
  const [viewText, setViewText] = React.useState('—');
  const [state, setState] = React.useState<LoadState>({ phase: 'empty', error: null, clips: [], maxFrame: 0 });
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState<string | null>(null);

  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewerRef = React.useRef<ViewerHandle | null>(null);

  React.useEffect(() => {
    if (hostRef.current === null) return undefined;
    const viewer = mountViewer(hostRef.current, { width: 800, height: 460 });
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // 播放中与拖转后的回读：帧号滑条 + 视角读数
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const viewer = viewerRef.current;
      if (viewer === null) return;
      const info = viewer.frameInfo();
      if (info !== null) setFrame(info.frame);
      const view = viewer.getViewState() as ViewState;
      setViewText(
        `az ${Math.round(view.camera.azimuth)}° · el ${Math.round(view.camera.elevation)}° · d ${view.camera.distance.toFixed(2)} · ${view.mode}`,
      );
    }, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const load = async (): Promise<void> => {
    const trimmed = modelPath.trim();
    if (trimmed === '') return;
    setState({ phase: 'loading', error: null, clips: [], maxFrame: 0 });
    setPlaying(false);
    setSent(null);
    try {
      const response = await fetch(resolveEndpoint(`kinemesh/model?path=${encodeURIComponent(trimmed)}`), {
        cache: 'no-store',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      const viewer = viewerRef.current;
      if (viewer === null) throw new Error('预览还没准备好');
      const scene = await loadSceneFromBytes(bytes, trimmed);
      viewer.loadScene(scene);
      const bounds = viewer.sceneBounds();
      const maxFrame = Math.max(0, Math.floor(bounds.durationSeconds * RENDER_FPS));
      setState({ phase: 'ready', error: null, clips: bounds.clips, maxFrame });
      setClip('');
      setFrame(0);
      viewer.applyView(defaultView(bounds.center, bounds.radius));
    } catch (cause) {
      setState({ phase: 'empty', error: cause instanceof Error ? cause.message : String(cause), clips: [], maxFrame: 0 });
    }
  };

  const applyClip = (nextClip: string): void => {
    setClip(nextClip);
    const viewer = viewerRef.current;
    if (viewer === null) return;
    setPlaying(false);
    viewer.applyView({
      ...viewer.getViewState(),
      clip: nextClip === '' ? null : nextClip,
      frame: 0,
      mode,
    });
    const info = viewer.frameInfo();
    setFrame(info?.frame ?? 0);
  };

  const togglePlay = (): void => {
    const viewer = viewerRef.current;
    if (viewer === null) return;
    if (playing) {
      viewer.pause();
      setPlaying(false);
      return;
    }
    viewer.play(clip === '' ? undefined : clip);
    setPlaying(true);
  };

  const seek = (next: number): void => {
    setFrame(next);
    void viewerRef.current?.seekFrame(next);
  };

  const changeMode = (next: ViewMode): void => {
    setMode(next);
    viewerRef.current?.setMode(next);
  };

  const send = async (): Promise<void> => {
    const viewer = viewerRef.current;
    if (viewer === null || modelPath.trim() === '') return;
    setSending(true);
    setSent(null);
    try {
      const response = await fetch(resolveEndpoint('kinemesh/analyze'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          path: modelPath.trim(),
          sessionId: connection?.sessionId ?? '',
          clip: clip === '' ? null : clip,
          frame,
          view: viewer.getViewState(),
          note: connection?.draft ?? null,
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (body?.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      if (connection !== null && connection.draft.trim() !== '') {
        try {
          connection.actions?.setDraft?.('');
        } catch {
          // 清空失败不影响已投递的分析
        }
      }
      setSent('已发给 AI：它会用 kinemesh_render 截这个视角并读图分析。');
      onClose();
    } catch (cause) {
      setSent(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <React.Fragment>
      <Styles />
      <div className="kinemesh-backdrop" onClick={onClose} role="presentation">
        <div className="kinemesh-dialog" role="dialog" aria-label="动析 3D 预览" onClick={(event) => event.stopPropagation()}>
          <header className="kinemesh-head">
            <span className="kinemesh-title">动析 · 3D 预览</span>
            <span className="kinemesh-sub">拖转视角；截图与 AI 分析用同一套构图</span>
            <span className="kinemesh-spacer" />
            <button type="button" className="kinemesh-iconbtn" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </header>
          <div className="kinemesh-toolbar">
            <input
              className="kinemesh-input"
              value={modelPath}
              placeholder="模型文件路径（.fbx / .glb / .gltf / .obj）"
              onChange={(event) => setModelPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void load();
              }}
            />
            <button type="button" className="kinemesh-btn" onClick={() => void load()} disabled={state.phase === 'loading'}>
              {state.phase === 'loading' ? '加载中…' : '加载'}
            </button>
            <select className="kinemesh-select" value={clip} onChange={(event) => applyClip(event.target.value)} disabled={state.clips.length === 0}>
              <option value="">（静态）</option>
              {state.clips.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select className="kinemesh-select" value={mode} onChange={(event) => changeMode(event.target.value as ViewMode)}>
              {VIEW_MODES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          {state.error !== null && <div className="kinemesh-banner">{state.error}</div>}
          {sent !== null && (
            <div className="kinemesh-banner" data-kind="ok">
              {sent}
            </div>
          )}
          <div className="kinemesh-stage" ref={hostRef}>
            {state.phase !== 'ready' && (
              <div className="kinemesh-placeholder">
                {state.phase === 'loading' ? '加载模型中…' : '输入模型文件路径并点「加载」。加载后可拖转、拖帧、播放，或直接发给 AI 分析。'}
              </div>
            )}
          </div>
          <div className="kinemesh-controls">
            <button type="button" className="kinemesh-btn" onClick={togglePlay} disabled={state.phase !== 'ready' || clip === ''}>
              {playing ? '暂停' : '播放'}
            </button>
            <input
              className="kinemesh-slider"
              type="range"
              min={0}
              max={Math.max(state.maxFrame, 1)}
              value={frame}
              onChange={(event) => seek(Number(event.target.value))}
              disabled={state.phase !== 'ready' || clip === ''}
            />
            <span className="kinemesh-frame">
              f{frame} / f{Math.max(state.maxFrame, 0)}
            </span>
          </div>
          <div className="kinemesh-readout">
            <span className="kinemesh-chip">{viewText}</span>
            <span>{`time = frame / ${RENDER_FPS}`}</span>
          </div>
          <div className="kinemesh-foot">
            <span className="kinemesh-sub">「发送」会把当前路径、片段、帧号与视角描述连同输入框附言一起交给当前会话的 AI。</span>
            <span className="kinemesh-spacer" />
            <button
              type="button"
              className="kinemesh-btn"
              data-primary="true"
              onClick={() => void send()}
              disabled={state.phase !== 'ready' || sending || (connection?.sessionId ?? '') === ''}
            >
              {sending ? '发送中…' : '发送给 AI 分析'}
            </button>
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

function defaultView(center: [number, number, number], radius: number): ViewState {
  return {
    camera: {
      azimuth: 45,
      elevation: 20,
      distance: radius * 2.2,
      target: [...center] as [number, number, number],
      fov: 40,
    },
    clip: null,
    frame: 0,
    mode: 'default',
  };
}

async function loadSceneFromBytes(data: ArrayBuffer, fileName: string) {
  // 与 kinemesh_info 同一套格式探测：浏览器端走 loader 的 CanonicalScene 路径
  const head = new Uint8Array(data, 0, Math.min(1024, data.byteLength));
  const entry = detectFormat(head, fileName);
  if (entry === null) throw new Error(`不认识的格式：${fileName}（支持 FBX / glTF / GLB / OBJ）`);
  return entry.load(data, { fileName });
}

export function apply(ctx: any): void {
  ctx.effect(() =>
    ctx.slots.inject(INPUT_LEFT_SLOT, () =>
      ctx.slots.register({ name: INPUT_LEFT_SLOT, id: ENTRY_ID, order: 35 }, (props: Record<string, unknown>) => (
        <LauncherButton {...props} />
      )),
    ),
  );
  ctx.effect(() =>
    ctx.slots.inject(OVERLAY_SLOT, () =>
      ctx.slots.register({ name: OVERLAY_SLOT, id: ENTRY_ID, order: 45 }, () =>
        overlayStore.getSnapshot() ? <PreviewDialog onClose={() => overlayStore.set(false)} /> : null,
      ),
    ),
  );
}
