// 截图页入口：构建期打成 viewer.js（IIFE，three.js + core 全内联），运行时由
// render/screenshot.ts 内联进独立 HTML，用 Playwright 打开。
// 通过 window.__kinemeshViewer 暴露最小桥接：载入模型 → 解析视角 → 逐帧出图。
// M3 的 DSH 预览面板直接复用 core/viewer/kinemesh-viewer.ts（同一模块，不经过本桥）。
import { analyzeWith } from './core/analyze-file.js';
import { KinemeshError, reasonOf } from './core/errors.js';
import { collectLabelTargets, strideLabelBatches } from './core/analyze/label-batches.js';
import { detectFormat, unknownFormatError } from './core/registry.js';
import { mountViewer, type ViewerHandle } from './core/viewer/kinemesh-viewer.js';
import type { CanonicalScene } from './core/types.js';
import { RENDER_FPS, type ViewState } from './core/viewstate.js';

interface LoadResult {
  ok: true;
  clips: string[];
  bounds: { center: [number, number, number]; radius: number };
  durationSeconds: number;
}

/** B.4 骨骼名标注入参：批次号（1 起，与 skeleton-report 批号/PNG 序号一致）| 'auto'（第 1 批）|
 *  'all'（全部骨骼名，允许重叠，调试用）| 显式骨骼名清单（skeleton 工具按 report 批次直发）| null（清除） */
type BoneLabelsSpec = number | 'auto' | 'all' | string[] | null;

interface BoneLabelsOutcome {
  /** 实际画出的标签数（名字未命中骨架的不计） */
  shown: number;
  /** 该模型按全骨架 stride 划分的批数（B.4） */
  batches: number;
  /** 本次生效的批号（'all' 或 1 起整数；null = 无标签） */
  batch: number | 'all' | null;
}

interface Bridge {
  load(b64: string, fileName: string): Promise<LoadResult | { ok: false; error: string }>;
  applyView(view: ViewState): void;
  seekFrame(frame: number): Promise<{ frame: number }>;
  frameInfo(): ReturnType<ViewerHandle['frameInfo']>;
  trackNames(): string[];
  setBoneLabels(spec: BoneLabelsSpec): BoneLabelsOutcome;
  /** 载入后推荐的渲染模式（0.7.1）：无 mesh → skeleton / 无贴图 → solid / 有贴图 → default */
  modeSuggestion(): ReturnType<ViewerHandle['modeSuggestion']>;
  ready(): Promise<void>;
}

let viewer: ViewerHandle | null = null;
let loadedScene: CanonicalScene | null = null;
let bounds: { center: [number, number, number]; radius: number; clips: string[]; durationSeconds: number } = {
  center: [0, 0, 0],
  radius: 1,
  clips: [],
  durationSeconds: 0,
};

function container(): HTMLElement {
  const found = document.getElementById('app');
  if (found === null) throw new Error('页面缺少 #app 容器');
  return found;
}

function getViewer(): ViewerHandle {
  if (viewer === null) {
    viewer = mountViewer(container(), { width: window.innerWidth, height: window.innerHeight });
  }
  return viewer;
}

async function load(b64: string, fileName: string): Promise<LoadResult | { ok: false; error: string }> {
  try {
    // atob 产出二进制字符串；必须逐字符取 charCodeAt（Uint8Array.from 对字符串元素会得到 NaN→0）
    const binary = Uint8Array.from(atob(b64), (character) => character.charCodeAt(0));
    const data = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer;
    const head = new Uint8Array(data, 0, Math.min(1024, data.byteLength));
    const entry = detectFormat(head, fileName);
    if (entry === null) throw unknownFormatError(fileName);
    const scene: CanonicalScene = await entry.load(data, { fileName });
    loadedScene = scene;
    getViewer().loadScene(scene);
    bounds = getViewer().sceneBounds();
    return {
      ok: true,
      clips: bounds.clips,
      bounds: { center: bounds.center, radius: bounds.radius },
      durationSeconds: bounds.durationSeconds,
    };
  } catch (error) {
    const message = error instanceof KinemeshError ? error.helpText() : reasonOf(error);
    return { ok: false, error: message };
  }
}

function setBoneLabels(spec: BoneLabelsSpec): BoneLabelsOutcome {
  if (spec === null || loadedScene === null) {
    getViewer().setBoneLabels(null);
    return { shown: 0, batches: 0, batch: null };
  }
  const targets = collectLabelTargets(loadedScene.object);
  if (spec === 'all') {
    return { shown: getViewer().setBoneLabels(targets.map((target) => target.name)), batches: strideLabelBatches(targets).length, batch: 'all' };
  }
  if (Array.isArray(spec)) {
    // 显式骨骼名清单（skeleton 工具按 report 批次直发）：批号由调用方自知，回 null
    return { shown: getViewer().setBoneLabels(spec), batches: strideLabelBatches(targets).length, batch: null };
  }
  // 批次号按全骨架 stride 划分（B = ceil(骨骼总数/12)）；'auto' = 第 1 批
  const batches = strideLabelBatches(targets);
  const batch = spec === 'auto' ? 1 : spec;
  const bones = batches[batch - 1] ?? [];
  return { shown: getViewer().setBoneLabels(bones), batches: batches.length, batch };
}

const bridge: Bridge = {
  load,
  applyView(view: ViewState): void {
    getViewer().applyView(view);
  },
  async seekFrame(frame: number): Promise<{ frame: number }> {
    const info = await getViewer().seekFrame(frame);
    void info;
    return { frame: getViewer().frameInfo()?.frame ?? frame };
  },
  frameInfo(): ReturnType<ViewerHandle['frameInfo']> {
    return getViewer().frameInfo();
  },
  trackNames(): string[] {
    return getViewer().trackNames();
  },
  setBoneLabels(spec: BoneLabelsSpec): BoneLabelsOutcome {
    return setBoneLabels(spec);
  },
  modeSuggestion(): ReturnType<ViewerHandle['modeSuggestion']> {
    return getViewer().modeSuggestion();
  },
  ready(): Promise<void> {
    return getViewer().ready();
  },
};

(window as unknown as Record<string, unknown>).__kinemeshViewer = bridge;
(window as unknown as Record<string, unknown>).__kinemeshRenderFps = RENDER_FPS;
