// Client 半入口：输入框左侧「动析」入口 + 预览浮层 + 会话「模型预览」页签（M6e，§6.10）。
// 预览画面与交互重构为共用组件 PreviewPane（浮层与页面同一渲染路径，不新增第二套渲染路径）；
// 页签在「本会话用过 kinemesh」（浮层加载过模型 / 发送过分析 / host 会话表非空）时出现，
// 会话身份由 header utilities 槽捕获（aiworkflow 同款），页签注册用 conversation.view 槽（aiworkflow syncRunTab 同款）。
// 预览用 core/viewer/kinemesh-viewer.ts（与 kinemesh_render 截图同一模块，构图一致）。
import * as React from 'react';
import { mountViewer, type ViewerHandle } from './core/viewer/kinemesh-viewer.js';
import { detectFormat } from './core/registry.js';
import { resolveEndpoint } from './endpoint.js';
import { Styles } from './styles.js';
import { RENDER_FPS, type ViewState, type ViewMode } from './core/viewstate.js';

export const inject = ['slots', 'locale'];

const HEADER_SLOT = 'conversation.session.header.utilities';
const SIDEBAR_LIST_SLOT = 'sidebar.panellist';
const MAIN_SLOT = 'main';
const CONVERSATION_VIEW_SLOT = 'conversation.view';
const ENTRY_ID = 'kinemesh-launcher';
const PANEL_ID = 'kinemesh';
const PREVIEW_TAB_ID = 'kinemesh-preview';
const VIEW_MODES: ViewMode[] = ['default', 'wireframe', 'skeleton', 'bones-overlay'];

// ———————— 预览状态记忆（0.6.0）———————
// 切换侧边栏面板/会话页签时组件会卸载，React state 随之丢失；把「已打开模型 + clip + 帧 + 模式」
// 记在模块级内存里（进程内，DSH 重启清空），重挂载时自动恢复——用户要求「未重启进程时保持」。

export interface PaneMemory {
  path: string;
  clip: string;
  frame: number;
  mode: ViewMode;
}

const paneMemories = new Map<string, PaneMemory>();

/** 读某块预览区的上次状态（无则 null） */
export function readPaneMemory(key: string): PaneMemory | null {
  return paneMemories.get(key) ?? null;
}

/** 写某块预览区的状态（只存有模型路径的；无路径不覆盖已有记忆） */
export function writePaneMemory(key: string, value: PaneMemory): void {
  if (value.path.trim() === '') return;
  paneMemories.set(key, { ...value });
}

/** 清空全部记忆（测试用） */
export function clearPaneMemories(): void {
  paneMemories.clear();
}

/** 支持拖入的模型扩展名（与 registry 的检测范围一致；大小写不敏感） */
export const MODEL_FILE_EXTENSIONS = ['.fbx', '.glb', '.gltf', '.obj'] as const;

/** 拖入文件是否为可预览的模型（纯函数，测试直测）：只看扩展名，实际格式由主进程嗅探 */
export function isModelFileName(fileName: string): boolean {
  const lowered = fileName.toLowerCase();
  return MODEL_FILE_EXTENSIONS.some((ext) => lowered.endsWith(ext));
}

/**
 * 取拖入文件的真实绝对路径。
 * 桌面版由 preload 暴露 `window.__DSH_HOST_PATHS__.pathFor(file)`（Electron webUtils.getPathForFile）；
 * 纯浏览器环境拿不到路径（安全限制）→ 返回 null，调用方提示改用粘贴路径。
 */
export function hostPathOfFile(file: File): string | null {
  const scope = globalThis as {
    __DSH_HOST_PATHS__?: { pathFor?: (file: File) => unknown };
  };
  const pathFor = scope.__DSH_HOST_PATHS__?.pathFor;
  if (typeof pathFor !== 'function') return null;
  try {
    const resolved = pathFor(file);
    return typeof resolved === 'string' && resolved.trim() !== '' ? resolved.trim() : null;
  } catch {
    return null;
  }
}

// ———————— locale（§6.10.4：页签文案与页面文本走 locale 服务，缺键回退中文） ————————

const LOCALE_NS = 'kinemesh-preview';
const ZH_TEXTS: Record<string, string> = {
  'panel.label': '动析预览',
  'standalone.title': '动析 · 模型预览',
  'standalone.subtitle': '本地只读：拖转视角、拖帧播放、看强度曲线（此页不接 AI 分析）',
  'tab.preview': '模型预览',
  'page.models': '本会话的模型',
  'page.emptySession': '会话信息不可用，先用「动析」浮层打开一次预览。',
  'page.emptyModels': '本会话还没有用过的模型：用「动析」浮层加载，或在下方输入路径打开。',
  'page.openPath': '模型文件路径（.fbx / .glb / .gltf / .obj）',
  'page.open': '打开',
  'list.animated': '动画',
  'timeline.hint': '强度曲线（点击/拖动定位帧）；色带=分段 guess，半透明=循环区间',
  'pane.load': '加载',
  'pane.loading': '加载中…',
  'pane.staticClip': '（静态）',
  'pane.placeholderLoading': '加载模型中…',
  'pane.placeholderPath': '输入模型文件路径并点「加载」。加载后可拖转、拖帧、播放，或直接发给 AI 分析。',
  'pane.placeholderPage': '从左侧选择模型。加载后可拖转、拖帧、播放，或直接发给 AI 分析。',
  'pane.play': '播放',
  'pane.pause': '暂停',
  'pane.digestChipTitle': '发送时将附带该动作分析 digest（分段 / loopCheck / 关键帧配方）',
  'pane.sentWithDigest': '已发给 AI：消息已附动作分析 digest（分段/loopCheck/关键帧配方）。',
  'pane.sentNoDigest': '已发给 AI：它会用 kinemesh_render 截这个视角并读图分析。',
  'pane.dropHint': '也可以把 .fbx / .glb / .gltf / .obj 直接拖到这里',
  'pane.dropActive': '松开即加载',
  'pane.footHint': '「发送」会把当前路径、片段、帧号、视角与动作分析 digest（如有）一起交给当前会话的 AI。',
  'pane.send': '发送给 AI 分析',
  'pane.sending': '发送中…',
  'dialog.title': '动析 · 3D 预览',
  'dialog.subtitle': '拖转视角；截图与 AI 分析用同一套构图',
  'dialog.close': '关闭',
};
const EN_TEXTS: Record<string, string> = {
  'panel.label': 'Kinemesh preview',
  'standalone.title': 'Kinemesh · model preview',
  'standalone.subtitle': 'Local read-only: orbit, scrub, play and inspect the energy curve (no AI in this page)',
  'tab.preview': 'Model preview',
  'page.models': 'Session models',
  'page.emptySession': 'Session info unavailable; open the preview overlay once first.',
  'page.emptyModels': 'No models used in this session yet: load one in the preview overlay, or type a path below.',
  'page.openPath': 'Model file path (.fbx / .glb / .gltf / .obj)',
  'page.open': 'Open',
  'list.animated': 'anim',
  'timeline.hint': 'Energy curve (click/drag to scrub); band = segment guess, translucent = loop range',
  'pane.load': 'Load',
  'pane.loading': 'Loading…',
  'pane.staticClip': '(static)',
  'pane.placeholderLoading': 'Loading model…',
  'pane.placeholderPath': 'Type a model file path and click Load. Then drag to orbit, scrub frames, play, or send to AI.',
  'pane.placeholderPage': 'Pick a model on the left. Then drag to orbit, scrub frames, play, or send to AI.',
  'pane.play': 'Play',
  'pane.pause': 'Pause',
  'pane.digestChipTitle': 'The motion-analysis digest (segments / loopCheck / keyframe recipe) will be attached when sending',
  'pane.sentWithDigest': 'Sent to AI: message includes the motion-analysis digest (segments/loopCheck/keyframe recipe).',
  'pane.sentNoDigest': 'Sent to AI: it will call kinemesh_render to capture this viewpoint and analyze the image.',
  'pane.dropHint': 'or drag a .fbx / .glb / .gltf / .obj file here',
  'pane.dropActive': 'Release to load',
  'pane.footHint': 'Send hands the current path, clip, frame, viewpoint and motion digest (if any) to this session\u2019s AI.',
  'pane.send': 'Send to AI',
  'pane.sending': 'Sending…',
  'dialog.title': 'Kinemesh · 3D preview',
  'dialog.subtitle': 'Drag to orbit; screenshots and AI analysis share the same framing',
  'dialog.close': 'Close',
};

type Translate = (key: string) => string;

/** 页面/页签文本的兜底翻译（locale 服务不可用时直接用中文） */
const fallbackTranslate: Translate = (key) => ZH_TEXTS[key] ?? key;
let translate: Translate = fallbackTranslate;

function registerTexts(ctx: any): () => void {
  const disposers: Array<() => void> = [];
  const packs: Array<readonly [string, Record<string, string>]> = [
    ['en', EN_TEXTS],
    ['zh', ZH_TEXTS],
    ['zh-CN', ZH_TEXTS],
    ['zh-Hans', ZH_TEXTS],
  ];
  for (const [locale, dict] of packs) {
    try {
      const dispose = ctx.locale?.register?.(LOCALE_NS, locale, dict);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch {
      // 已注册或不支持的标签：忽略，其余 locale 继续
    }
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // 重复释放忽略
      }
    }
  };
}

function bindTranslate(ctx: any): Translate {
  const raw = ctx.locale?.bind?.(LOCALE_NS) as ((key: string) => string) | undefined;
  if (typeof raw !== 'function') return fallbackTranslate;
  return (key) => {
    const value = raw(key);
    // 当前语言缺少该键时退回中文，而不是把 key 直接甩给用户
    return value === key ? (ZH_TEXTS[key] ?? key) : value;
  };
}

// ———————— 纯函数（tests/kinemesh/client-preview.test.ts 直测） ————————

/** 页签可见性（§6.9 M6e 验收第一条：未用插件的会话没有页签） */
export function shouldShowPreviewTab(sessionId: string, used: boolean): boolean {
  return sessionId.trim() !== '' && used;
}

/** 能量序列归一到 0..1（峰值=1；空/全零恒 0；负值截 0） */
export function normalizeEnergySeries(values: number[]): number[] {
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (max <= 0) return values.map(() => 0);
  return values.map((value) => (value <= 0 ? 0 : value / max));
}

/** 归一能量 → SVG 折线点列（[x, y]，y=0 为顶部；width/height 是坐标空间尺寸） */
export function energyPoints(values: number[], width: number, height: number): Array<[number, number]> {
  if (values.length === 0 || width <= 0 || height <= 0) return [];
  if (values.length === 1) return [[0, height]];
  const last = values.length - 1;
  return values.map((value, k) => [
    Number(((k / last) * width).toFixed(2)),
    Number(((1 - value) * height).toFixed(2)),
  ]);
}

/** 分段色带颜色（label 分类着色；未知 label 用同一蓝色） */
const SEGMENT_COLORS: Record<string, string> = {
  idle: '#6f7db8',
  'contact-move': '#3f8f6f',
  action: '#c98a3d',
  airborne: '#8f6fc0',
};

export function segmentColor(label: string): string {
  return SEGMENT_COLORS[label] ?? '#5c90d9';
}

/** 帧号 → 时间轴百分比（0..100，越界截断；maxFrame ≤ 0 恒 0） */
export function frameToPercent(frame: number, maxFrame: number): number {
  if (!Number.isFinite(frame) || !Number.isFinite(maxFrame) || maxFrame <= 0) return 0;
  const ratio = (Math.min(Math.max(frame, 0), maxFrame) / maxFrame) * 100;
  return Number(ratio.toFixed(3));
}

/** host /kinemesh/analysis 返回的 summaryDigest 里前端消费的字段（防御式可选） */
export interface DigestSummary {
  clip?: { name?: string; duration?: number; frames?: number };
  segments?: Array<{ frameStart?: number; frameEnd?: number; label?: string; guess?: string; level?: string }>;
  loopCheck?: { verdict?: string; bestLoopRange?: { frameStart?: number; frameEnd?: number } | null } | null;
  facts?: string[];
  keyframeRender?: { frames?: number[]; views?: string[]; mode?: string };
}

/** digest 摘要一行（发送按钮旁 chip 文案：clip · 段数 · loopCheck verdict）；无有效内容返回空串 */
export function formatDigestHeadline(digest: DigestSummary | null | undefined): string {
  if (digest === null || digest === undefined || typeof digest !== 'object') return '';
  const parts: string[] = [];
  if (typeof digest.clip?.name === 'string' && digest.clip.name !== '') parts.push(`clip「${digest.clip.name}」`);
  if (Array.isArray(digest.segments) && digest.segments.length > 0) parts.push(`${digest.segments.length} 段`);
  if (typeof digest.loopCheck?.verdict === 'string' && digest.loopCheck.verdict !== '') parts.push(digest.loopCheck.verdict);
  return parts.join(' · ');
}

/**
 * 发送时随消息附带的 digest：静态态（未选 clip，消息正文写「无动画/静态」）不附——
 * 此时 analysis 数据可能是缺省第一个 clip 的，附上去会和正文互斥（review Important #1）。
 */
export function pickSendDigest(clip: string, analysis: { summaryDigest: DigestSummary } | null): DigestSummary | null {
  if (clip === '' || analysis === null) return null;
  return analysis.summaryDigest ?? null;
}

// ———————— host /kinemesh/analysis 的返回体（与 src/host.ts PreviewAnalysis 对齐） ————————

interface AnalysisPayload {
  summaryDigest: DigestSummary;
  segments: NonNullable<DigestSummary['segments']>;
  keyframes: Array<{ frame: number; time?: number; reason?: string; note?: string }>;
  frames: number[];
  energy: number[];
}

// ———————— 页签会话状态（§6.10.1：header 槽捕获 sessionId；用过即出现；切会话重新探测） ————————

interface PreviewSessionSnapshot {
  sessionId: string;
  used: boolean;
}

const previewSession = {
  listeners: new Set<() => void>(),
  state: { sessionId: '', used: false } as PreviewSessionSnapshot,
  probeSeq: 0,
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  },
  getSnapshot(): PreviewSessionSnapshot {
    return this.state;
  },
  publish(): void {
    for (const listener of this.listeners) listener();
  },
  setSession(sessionId: string): void {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (this.state.sessionId === id) return;
    this.state = { sessionId: id, used: false };
    this.publish();
    void this.probe(id);
  },
  markUsed(sessionId?: string): void {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (id !== '' && id !== this.state.sessionId) this.setSession(id);
    if (!this.state.used) {
      this.state = { ...this.state, used: true };
      this.publish();
    }
  },
  /** 页签打开/切会话时向 host 轻量拉一次清单（§6.10.1：不做轮询） */
  async probe(sessionId: string): Promise<void> {
    if (sessionId === '') return;
    const seq = ++this.probeSeq;
    try {
      const response = await fetch(resolveEndpoint(`kinemesh/session-models?sessionId=${encodeURIComponent(sessionId)}`), {
        cache: 'no-store',
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; models?: unknown[] } | null;
      const has = body?.ok === true && Array.isArray(body.models) && body.models.length > 0;
      if (has && seq === this.probeSeq && this.state.sessionId === sessionId) this.markUsed();
    } catch {
      // host 不可达：保持无页签，等浮层/发送行为置 used
    }
  },
};

function SessionCapture({ sessionId, store }: { sessionId: string; store: typeof previewSession }): null {
  React.useEffect(() => {
    store.setSession(sessionId);
  }, [sessionId, store]);
  return null;
}

// ———————— 强度曲线时间轴（§6.10.3）：曲线 + 播放头 + 分段色带 + 循环高亮 ————————

const TIMELINE_VB_W = 600;
const TIMELINE_VB_H = 44;
const TIMELINE_CURVE_H = 28;
const TIMELINE_BAND_TOP = 32;
const TIMELINE_BAND_H = 9;

function MotionTimeline(props: {
  frames: number[];
  energy: number[];
  segments: NonNullable<DigestSummary['segments']>;
  loopFrames: { start: number; end: number } | null;
  maxFrame: number;
  frame: number;
  onSeek: (frame: number) => void;
}): React.ReactElement | null {
  const dragging = React.useRef(false);
  const normalized = normalizeEnergySeries(props.energy);
  if (normalized.length === 0) return null;
  const points = energyPoints(normalized, TIMELINE_VB_W, TIMELINE_CURVE_H)
    .map(([x, y]) => `${x},${y}`)
    .join(' ');
  const playheadX = (frameToPercent(props.frame, props.maxFrame) / 100) * TIMELINE_VB_W;
  const seekFromEvent = (event: React.PointerEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    props.onSeek(Math.round(ratio * props.maxFrame));
  };
  return (
    <div className="kinemesh-timeline">
      <svg
        viewBox={`0 0 ${TIMELINE_VB_W} ${TIMELINE_VB_H}`}
        preserveAspectRatio="none"
        role="img"
        onPointerDown={(event) => {
          dragging.current = true;
          seekFromEvent(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) seekFromEvent(event);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerLeave={() => {
          dragging.current = false;
        }}
      >
        {props.loopFrames !== null && (
          <rect
            x={(frameToPercent(props.loopFrames.start, props.maxFrame) / 100) * TIMELINE_VB_W}
            y={0}
            width={Math.max(
              2,
              ((frameToPercent(props.loopFrames.end, props.maxFrame) - frameToPercent(props.loopFrames.start, props.maxFrame)) /
                100) *
                TIMELINE_VB_W,
            )}
            height={TIMELINE_VB_H}
            fill="rgba(230,190,90,0.22)"
            stroke="rgba(230,190,90,0.55)"
            strokeDasharray="4 3"
            strokeWidth="1"
          >
            <title>{`循环区间 frame ${props.loopFrames.start}–${props.loopFrames.end}（loopCheck.bestLoopRange）`}</title>
          </rect>
        )}
        <polyline points={points} fill="none" stroke="var(--dsw-alias-brand-primary, #4c8bf5)" strokeWidth="1.5" />
        <line x1={playheadX} y1={0} x2={playheadX} y2={TIMELINE_VB_H} stroke="var(--dsw-alias-label-primary, #e8e8e8)" strokeWidth="1.2" opacity="0.85" />
        {props.segments.map((segment, index) => {
          const start = frameToPercent(segment.frameStart ?? 0, props.maxFrame);
          const end = frameToPercent(segment.frameEnd ?? segment.frameStart ?? 0, props.maxFrame);
          const x = (start / 100) * TIMELINE_VB_W;
          const width = Math.max(2, ((end - start) / 100) * TIMELINE_VB_W);
          const label = segment.label ?? '';
          const guess = segment.guess ?? '';
          return (
            <rect
              key={`${segment.frameStart ?? index}-${index}`}
              x={x}
              y={TIMELINE_BAND_TOP}
              width={width}
              height={TIMELINE_BAND_H}
              fill={segmentColor(label)}
              opacity="0.9"
            >
              <title>{`#${index + 1} frame ${segment.frameStart ?? '?'}–${segment.frameEnd ?? '?'}：${label} · guess ${guess} · 强度 ${segment.level ?? '?'}`}</title>
            </rect>
          );
        })}
      </svg>
      <span className="kinemesh-timelinehint">{translate('timeline.hint')}</span>
    </div>
  );
}

// ———————— 预览面板主体（浮层与页面共用，§6.10.2） ————————

interface LoadState {
  phase: 'empty' | 'loading' | 'ready';
  error: string | null;
  clips: string[];
  maxFrame: number;
}

function PreviewPane(props: {
  sessionId: string;
  /** 输入框附言（浮层传入；页面无） */
  note?: string | null;
  /** 是否显示路径输入（独立预览页 true；会话页签由左侧列表驱动） */
  showPathInput?: boolean;
  /** 是否显示「发送给 AI 分析」（独立预览页 false——纯工具内置功能，不接 AI） */
  allowSend?: boolean;
  /** 状态记忆键（'standalone' / 'tab'）：切面板/页签回来时恢复已加载模型与进度；缺省不记忆 */
  persistKey?: string;
  /** 外部请求加载某路径（页面选中/打开模型时） */
  loadRequest?: { path: string; nonce: number } | null;
  /** 加载成功上报（页面刷新会话列表用） */
  onLoaded?: (path: string) => void;
  /** 发送成功上报 */
  onSendSuccess?: () => void;
}): React.ReactElement {
  const showPathInput = props.showPathInput !== false;
  const allowSend = props.allowSend !== false;
  const [pathInput, setPathInput] = React.useState('');
  const [loadedPath, setLoadedPath] = React.useState('');
  const [clip, setClip] = React.useState('');
  const [frame, setFrame] = React.useState(0);
  const [mode, setMode] = React.useState<ViewMode>('default');
  const [playing, setPlaying] = React.useState(false);
  const [viewText, setViewText] = React.useState('—');
  const [state, setState] = React.useState<LoadState>({ phase: 'empty', error: null, clips: [], maxFrame: 0 });
  const [analysis, setAnalysis] = React.useState<{ loading: boolean; data: AnalysisPayload | null }>({
    loading: false,
    data: null,
  });
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState<string | null>(null);
  /** 拖入文件高亮（dragenter/dragleave 计数，避免子元素抖动） */
  const [dragOver, setDragOver] = React.useState(false);

  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewerRef = React.useRef<ViewerHandle | null>(null);
  const analysisSeq = React.useRef(0);
  const lastRequestRef = React.useRef<{ path: string; nonce: number } | null>(null);

  React.useEffect(() => {
    if (hostRef.current === null) return undefined;
    // 0.6.0：不传固定宽高 → viewer 跟随容器尺寸（独立页全宽/页签/浮层自适应，ResizeObserver 生效）
    const viewer = mountViewer(hostRef.current);
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // 播放中与拖转后的回读：帧号滑条 + 播放头 + 视角读数
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

  // 曲线数据从 host 路由取（§6.10.3：不在 client 里解析模型文件）；失败静默降级（无曲线、消息不带 digest）
  const fetchAnalysis = async (targetPath: string, clipName: string): Promise<void> => {
    if (targetPath === '') {
      setAnalysis({ loading: false, data: null });
      return;
    }
    const seq = ++analysisSeq.current;
    setAnalysis({ loading: true, data: null });
    try {
      const url = resolveEndpoint(
        `kinemesh/analysis?path=${encodeURIComponent(targetPath)}&clip=${encodeURIComponent(clipName)}`,
      );
      const response = await fetch(url, { cache: 'no-store' });
      const body = (await response.json().catch(() => null)) as (AnalysisPayload & { ok?: boolean }) | null;
      if (body?.ok === true && Array.isArray(body.energy)) {
        if (seq === analysisSeq.current) setAnalysis({ loading: false, data: body });
      } else if (seq === analysisSeq.current) {
        setAnalysis({ loading: false, data: null });
      }
    } catch {
      if (seq === analysisSeq.current) setAnalysis({ loading: false, data: null });
    }
  };

  const load = async (rawTarget?: string): Promise<void> => {
    const target = (rawTarget ?? pathInput).trim();
    if (target === '') return;
    setState({ phase: 'loading', error: null, clips: [], maxFrame: 0 });
    setPlaying(false);
    setSent(null);
    try {
      const sessionQuery = props.sessionId !== '' ? `&sessionId=${encodeURIComponent(props.sessionId)}` : '';
      const response = await fetch(resolveEndpoint(`kinemesh/model?path=${encodeURIComponent(target)}${sessionQuery}`), {
        cache: 'no-store',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      const viewer = viewerRef.current;
      if (viewer === null) throw new Error('预览还没准备好');
      const scene = await loadSceneFromBytes(bytes, target);
      viewer.loadScene(scene);
      const bounds = viewer.sceneBounds();
      const maxFrame = Math.max(0, Math.floor(bounds.durationSeconds * RENDER_FPS));
      setState({ phase: 'ready', error: null, clips: bounds.clips, maxFrame });
      setLoadedPath(target);
      // 0.6.0 修复：加载动画资产后自动选第一个 clip——旧实现恒置 ''（静态），播放按钮永远 disabled
      const memory = props.persistKey === undefined ? null : readPaneMemory(props.persistKey);
      const rememberedClip =
        memory !== null && memory.path === target && bounds.clips.includes(memory.clip) ? memory.clip : (bounds.clips[0] ?? '');
      const rememberedFrame = memory !== null && memory.path === target ? memory.frame : 0;
      const startFrame = Math.max(0, Math.min(rememberedFrame, maxFrame));
      setClip(rememberedClip);
      setFrame(startFrame);
      viewer.applyView(defaultView(bounds.center, bounds.radius));
      if (rememberedClip !== '' && startFrame > 0) viewer.seekFrame(startFrame);
      if (props.sessionId !== '') previewSession.markUsed(props.sessionId);
      props.onLoaded?.(target);
      if (bounds.clips.length > 0) void fetchAnalysis(target, rememberedClip);
      else setAnalysis({ loading: false, data: null });
    } catch (cause) {
      setAnalysis({ loading: false, data: null });
      setState({ phase: 'empty', error: cause instanceof Error ? cause.message : String(cause), clips: [], maxFrame: 0 });
    }
  };

  // 状态记忆（0.6.0：切到别的侧边栏面板/页签再回来，已加载模型与进度不丢；进程内内存，重启清空）
  React.useEffect(() => {
    if (props.persistKey === undefined || loadedPath === '') return;
    writePaneMemory(props.persistKey, { path: loadedPath, clip, frame, mode });
  }, [props.persistKey, loadedPath, clip, frame, mode]);

  // 首次挂载恢复上次的模型（必须在 load 定义之后）
  const restoredRef = React.useRef(false);
  React.useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (props.persistKey === undefined) return;
    const memory = readPaneMemory(props.persistKey);
    if (memory === null || memory.path === '') return;
    setPathInput(memory.path);
    void load(memory.path);
  }, [props.persistKey]);

  // 页面选中/打开模型：nonce 变化才重新加载（避免同一路径的无关重渲染触发重载）
  React.useEffect(() => {
    const request = props.loadRequest ?? null;
    if (request === null || request.path === '') return;
    if (lastRequestRef.current !== null && lastRequestRef.current.nonce === request.nonce) return;
    lastRequestRef.current = request;
    setPathInput(request.path);
    void load(request.path);
  }, [props.loadRequest]);

  // ———————— 拖入文件（桌面版经 __DSH_HOST_PATHS__.pathFor 取真实路径） ————————
  const dragDepth = React.useRef(0);
  const onDragEnter = (event: React.DragEvent): void => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (event: React.DragEvent): void => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const file = event.dataTransfer?.files?.[0];
    if (file === undefined) return;
    if (!isModelFileName(file.name)) {
      setState({
        phase: 'empty',
        error: `不支持的文件类型：${file.name}（支持 ${MODEL_FILE_EXTENSIONS.join(' / ')}）`,
        clips: [],
        maxFrame: 0,
      });
      return;
    }
    const resolved = hostPathOfFile(file);
    if (resolved === null) {
      setState({
        phase: 'empty',
        error: '当前环境拿不到拖入文件的真实路径（浏览器安全限制）：请把模型路径粘贴到输入框再点「加载」。',
        clips: [],
        maxFrame: 0,
      });
      return;
    }
    setPathInput(resolved);
    void load(resolved);
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
    void fetchAnalysis(loadedPath, nextClip);
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
    if (viewerRef.current === null || loadedPath === '' || props.sessionId === '') return;
    setSending(true);
    setSent(null);
    try {
      // 静态态（clip === ''）不附 digest：analysis 缓存是缺省第一个 clip 的，附上会与正文「无动画/静态」互斥
      const digestAttached = pickSendDigest(clip, analysis.data);
      const response = await fetch(resolveEndpoint('kinemesh/analyze'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          path: loadedPath,
          sessionId: props.sessionId,
          clip: clip === '' ? null : clip,
          frame,
          view: viewerRef.current.getViewState(),
          note: props.note ?? null,
          digest: digestAttached,
        }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (body?.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      previewSession.markUsed(props.sessionId);
      setSent(digestAttached !== null ? translate('pane.sentWithDigest') : translate('pane.sentNoDigest'));
      props.onSendSuccess?.();
    } catch (cause) {
      setSent(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const loopFrames = React.useMemo<{ start: number; end: number } | null>(() => {
    // digest 的 bestLoopRange 已是 30fps 帧号（report.buildSummary 出口换算），直接使用
    const range = analysis.data?.summaryDigest?.loopCheck?.bestLoopRange ?? null;
    if (
      range === null ||
      typeof range !== 'object' ||
      typeof range.frameStart !== 'number' ||
      typeof range.frameEnd !== 'number'
    ) {
      return null;
    }
    const start = range.frameStart;
    const end = range.frameEnd;
    if (start === undefined || end === undefined) return null;
    return { start, end: Math.max(end, start) };
  }, [analysis.data]);

  // chip 与发送口径一致：静态态（clip === ''）不显示、不附 digest
  const digestHeadline = clip === '' ? '' : formatDigestHeadline(analysis.data?.summaryDigest ?? null);

  return (
    <React.Fragment>
      <Styles />
      <div className="kinemesh-toolbar">
        {showPathInput && (
          <React.Fragment>
            <input
              className="kinemesh-input"
              value={pathInput}
              placeholder={translate('page.openPath')}
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void load();
              }}
            />
            <button type="button" className="kinemesh-btn" onClick={() => void load()} disabled={state.phase === 'loading'}>
              {state.phase === 'loading' ? translate('pane.loading') : translate('pane.load')}
            </button>
          </React.Fragment>
        )}
        <select className="kinemesh-select" value={clip} onChange={(event) => applyClip(event.target.value)} disabled={state.clips.length === 0}>
          <option value="">{translate('pane.staticClip')}</option>
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
      <div
        className="kinemesh-stage"
        ref={hostRef}
        data-dragover={dragOver ? 'true' : undefined}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {state.phase !== 'ready' && (
          <div className="kinemesh-placeholder">
            {state.phase === 'loading'
              ? translate('pane.placeholderLoading')
              : showPathInput
                ? translate('pane.placeholderPath')
                : translate('pane.placeholderPage')}
            {state.phase === 'empty' && <span className="kinemesh-dropzone-hint">{translate('pane.dropHint')}</span>}
          </div>
        )}
        {dragOver && <div className="kinemesh-dropmask">{translate('pane.dropActive')}</div>}
      </div>
      {state.phase === 'ready' && clip !== '' && analysis.data !== null && (
        <MotionTimeline
          frames={analysis.data.frames}
          energy={analysis.data.energy}
          segments={analysis.data.segments}
          loopFrames={loopFrames}
          maxFrame={state.maxFrame}
          frame={frame}
          onSeek={seek}
        />
      )}
      <div className="kinemesh-controls">
        <button type="button" className="kinemesh-btn" onClick={togglePlay} disabled={state.phase !== 'ready' || clip === ''}>
          {playing ? translate('pane.pause') : translate('pane.play')}
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
        {digestHeadline !== '' && (
          <span className="kinemesh-chip" title={translate('pane.digestChipTitle')}>
            {`digest ${digestHeadline}`}
          </span>
        )}
        <span>{`time = frame / ${RENDER_FPS}`}</span>
      </div>
      {allowSend && (
        <div className="kinemesh-foot">
          <span className="kinemesh-sub">{translate('pane.footHint')}</span>
          <span className="kinemesh-spacer" />
          <button
            type="button"
            className="kinemesh-btn"
            data-primary="true"
            onClick={() => void send()}
            disabled={state.phase !== 'ready' || sending || props.sessionId === ''}
          >
            {sending ? translate('pane.sending') : translate('pane.send')}
          </button>
        </div>
      )}
    </React.Fragment>
  );
}

// ———————— 独立预览页（左侧侧边栏入口，0.6.0：纯工具内置功能，不接 AI） ————————

/** 侧边栏图标（与「动析」品牌一致的多面体） */
function KinemeshIcon({ size = 18, active = false }: { size?: number; active?: boolean }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block' }}>
      <path
        d="M12 3.5 20 8l-8 4.5L4 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        opacity={active ? 1 : 0.85}
      />
      <path d="M4 8v8l8 4.5V12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M20 8v8l-8 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity={active ? 1 : 0.6} />
    </svg>
  );
}

/**
 * 独立预览页：DSH 左侧侧边栏入口打开的纯预览（拖转 / 播放 / 强度曲线 / 拖入文件），
 * **不显示「发送给 AI 分析」**（那是会话页签的功能）。不依赖会话，无 sessionId 也可用。
 */
export function StandalonePreviewPage(): React.ReactElement {
  return (
    <React.Fragment>
      <Styles />
      <div className="kinemesh-standalone">
        <header className="kinemesh-standalonehead">
          <span className="kinemesh-title">{translate('standalone.title')}</span>
          <span className="kinemesh-sub">{translate('standalone.subtitle')}</span>
        </header>
        <div className="kinemesh-standalonemain">
          <PreviewPane sessionId="" showPathInput allowSend={false} persistKey="standalone" />
        </div>
      </div>
    </React.Fragment>
  );
}

// ———————— 模型预览页（conversation.view 页签，§6.10.2） ————————

interface SessionModelEntry {
  path: string;
  name: string;
  animated: boolean;
  clips: string[];
  bytes: number;
}

function PreviewPage({ sessionId }: { sessionId?: string }): React.ReactElement {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  const [models, setModels] = React.useState<SessionModelEntry[]>([]);
  const [selected, setSelected] = React.useState('');
  const [inputPath, setInputPath] = React.useState('');
  const [loadRequest, setLoadRequest] = React.useState<{ path: string; nonce: number } | null>(null);
  const nonceRef = React.useRef(0);

  const refresh = React.useCallback(async (): Promise<SessionModelEntry[]> => {
    if (sid === '') return [];
    try {
      const response = await fetch(resolveEndpoint(`kinemesh/session-models?sessionId=${encodeURIComponent(sid)}`), {
        cache: 'no-store',
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; models?: SessionModelEntry[] } | null;
      const list = body?.ok === true && Array.isArray(body.models) ? body.models : [];
      setModels(list);
      return list;
    } catch {
      return [];
    }
  }, [sid]);

  // 页签打开时拉一次清单（§6.10.1：不做轮询）；默认选第一个
  React.useEffect(() => {
    setModels([]);
    setSelected('');
    setLoadRequest(null);
    let cancelled = false;
    void (async () => {
      const list = await refresh();
      if (!cancelled && list.length > 0) {
        const first = list[0]!;
        setSelected(first.path);
        setLoadRequest({ path: first.path, nonce: ++nonceRef.current });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const openPath = (raw: string): void => {
    const target = raw.trim();
    if (target === '') return;
    setSelected(target);
    setLoadRequest({ path: target, nonce: ++nonceRef.current });
  };

  // 加载成功即刷新会话清单：model 路由已带 sessionId 记录，host 清单是唯一事实源
  const handleLoaded = (path: string): void => {
    if (path !== '') void refresh();
  };

  if (sid === '') {
    return (
      <React.Fragment>
        <Styles />
        <div className="kinemesh-page">
          <div className="kinemesh-pageholder">{translate('page.emptySession')}</div>
        </div>
      </React.Fragment>
    );
  }

  return (
    <React.Fragment>
      <Styles />
      <div className="kinemesh-page">
        <aside className="kinemesh-side">
          <div className="kinemesh-sidehead">{translate('page.models')}</div>
          <div className="kinemesh-sideitems">
            {models.length === 0 ? (
              <div className="kinemesh-sideempty">{translate('page.emptyModels')}</div>
            ) : (
              models.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="kinemesh-sideitem"
                  data-active={selected === entry.path ? 'true' : 'false'}
                  title={entry.path}
                  onClick={() => openPath(entry.path)}
                >
                  <span className="kinemesh-sidename">{entry.name}</span>
                  {entry.animated && <span className="kinemesh-badge">{translate('list.animated')}</span>}
                </button>
              ))
            )}
          </div>
          <div className="kinemesh-sidefoot">
            <input
              className="kinemesh-input"
              value={inputPath}
              placeholder={translate('page.openPath')}
              onChange={(event) => setInputPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') openPath(inputPath);
              }}
            />
            <button type="button" className="kinemesh-btn" onClick={() => openPath(inputPath)}>
              {translate('page.open')}
            </button>
          </div>
        </aside>
        <section className="kinemesh-main">
          <PreviewPane sessionId={sid} showPathInput={false} loadRequest={loadRequest} onLoaded={handleLoaded} persistKey="tab" />
        </section>
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
  const disposeTexts = registerTexts(ctx);
  translate = bindTranslate(ctx);
  ctx.effect(() => () => {
    translate = fallbackTranslate;
    disposeTexts();
  });

  // ———— 模型预览页签（conversation.view）：本会话用过 kinemesh 才注册（aiworkflow syncRunTab 同款） ————
  let tabDispose: (() => void) | null = null;
  const syncPreviewTab = (): void => {
    const snap = previewSession.getSnapshot();
    const show = shouldShowPreviewTab(snap.sessionId, snap.used);
    try {
      if (show && tabDispose === null) {
        tabDispose = ctx.slots.inject(CONVERSATION_VIEW_SLOT, () =>
          ctx.slots.register(
            { name: CONVERSATION_VIEW_SLOT, id: PREVIEW_TAB_ID, order: 20, label: () => translate('tab.preview') },
            (props: Record<string, unknown>) => (
              <PreviewPage sessionId={typeof props.sessionId === 'string' ? props.sessionId : undefined} />
            ),
          ),
        );
      } else if (!show && tabDispose !== null) {
        const dispose = tabDispose;
        tabDispose = null;
        dispose();
      }
    } catch {
      // 页签注册失败不阻塞其余插槽
    }
  };
  ctx.effect(() => {
    const off = previewSession.subscribe(syncPreviewTab);
    syncPreviewTab();
    return () => {
      off();
      if (tabDispose !== null) {
        const dispose = tabDispose;
        tabDispose = null;
        dispose();
      }
    };
  });

  // header utilities：捕获当前会话 id（aiworkflow 同款口径），不渲染任何可见节点
  ctx.effect(() =>
    ctx.slots.inject(HEADER_SLOT, () =>
      ctx.slots.register({ name: HEADER_SLOT, id: PREVIEW_TAB_ID, order: 45 }, (props: Record<string, unknown>) => (
        <SessionCapture sessionId={typeof props.sessionId === 'string' ? props.sessionId : ''} store={previewSession} />
      )),
    ),
  );

  // ———— 左侧侧边栏入口 + 主面板：独立预览页（0.6.0，纯工具内置功能，不接 AI） ————
  // 与 aiworkflow 同款机制：sidebar.panellist 出图标，main 槽按同 id 切到该面板。
  const layout = ctx.get('layout') as { selectPanel?: (panelId: string | null) => void } | undefined;
  ctx.effect(() =>
    ctx.slots.inject(SIDEBAR_LIST_SLOT, () =>
      ctx.slots.register(
        { name: SIDEBAR_LIST_SLOT, id: PANEL_ID, order: 50, label: () => translate('panel.label') },
        (props: { size?: number; active?: boolean }) => <KinemeshIcon size={props.size} active={props.active} />,
      ),
    ),
  );
  ctx.effect(() =>
    ctx.slots.inject(MAIN_SLOT, () => {
      try {
        return ctx.slots.register({ name: MAIN_SLOT, key: PANEL_ID }, () => <StandalonePreviewPage />);
      } catch {
        return () => undefined;
      }
    }),
  );
  void layout;
}
