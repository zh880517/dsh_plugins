// 截图管线（设计文档 §4.5）：Playwright(chromium) + 内嵌 viewer 的独立 HTML。
// 浏览器进程按次启停，不做常驻服务（红线）。输入模型字节 + ViewState，输出 PNG 绝对路径数组。
// viewer.js 是构建期从 src/viewer-page.ts 打出的 IIFE（scripts/build-plugin.mjs 通用第三产物），
// 与插件产物一起分发；本模块在运行时把它内联进 HTML，不依赖 node_modules 里有 three。
// B.4 骨骼名标注截图走同一条 viewer 页 + 桥接（setBoneLabels），只是编排循环不同
// （renderLabelScreenshots：每批 × 每视角），不另造渲染路径。
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KinemeshError, reasonOf } from '../errors.js';
import { orbit8Azimuths, resolveView, type NormalizedViewInput, type ViewState } from '../viewstate.js';

export interface RenderRequest {
  data: ArrayBuffer;
  fileName: string;
  /** kinemesh_render 的 view / viewPreset / mode / clip / frame 聚合入参（frame 被忽略，用 frames 批量） */
  viewInput: NormalizedViewInput;
  /** 要渲染的帧号（整数）；orbit8 时每帧 × 8 方位 */
  frames: number[];
  width?: number;
  height?: number;
  /** PNG 输出目录；缺省 <系统临时目录>/kinemesh-shots */
  outDir?: string;
  /** B.4 骨骼名标注（与 mode: skeleton / bones-overlay 联用）：'auto'（第 1 批）| 批次号（1 起）| 'all'（全部骨骼名，调试用） */
  boneLabels?: number | 'auto' | 'all';
}

export interface RenderResult {
  /** PNG 绝对路径（按渲染顺序） */
  images: string[];
  warnings: string[];
}

/** B.4 标注截图的一批：batch = 1 起批号（与 skeleton-report 的 batches[].batch / PNG 两位序号一致） */
export interface LabelShotBatch {
  batch: number;
  /** 该批要标注的骨骼名（skeleton-report 批次清单直发，保证与 report 批次严格一致） */
  bones: string[];
}

export interface LabelShotRequest {
  data: ArrayBuffer;
  fileName: string;
  /** 批次清单（空批跳过；全空不出图） */
  batches: LabelShotBatch[];
  /** 视角清单（B.4 固化 front / side，由调用方传入） */
  views: Array<'front' | 'side'>;
  /** PNG 输出目录（skeleton 的 run 目录；必填——落盘位置由调用方决定） */
  outDir: string;
  width?: number;
  height?: number;
}

const MAX_FRAMES = 64;
const MAX_LABEL_SHOTS = 128;
const PAGE_TIMEOUT_MS = 60_000;

export async function renderScreenshots(request: RenderRequest): Promise<RenderResult> {
  const frames = request.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new KinemeshError('frames 为空：至少给一个帧号。', 'frames 是整数数组，例如 "frames": [30]；静态模型传 [0]。');
  }
  if (frames.length > MAX_FRAMES) {
    throw new KinemeshError(`一次最多渲染 ${MAX_FRAMES} 帧（收到 ${frames.length}）。`, '分批调用；连拍动画关键帧建议 5～9 帧。');
  }
  const width = clampInt(request.width ?? 1280, 64, 4096);
  const height = clampInt(request.height ?? 720, 64, 4096);
  const workDir = path.join(request.outDir ?? path.join(tmpdir(), 'kinemesh-shots'), `run-${Date.now()}-${process.pid}`);
  await mkdir(workDir, { recursive: true });

  const session = await openShotPage(width, height);
  const images: string[] = [];
  try {
    const loadOutcome = await loadModelIntoPage(session.page, request.data, request.fileName);
    if (!loadOutcome.ok) {
      throw new KinemeshError(`模型载入失败：${loadOutcome.error}`, '先把文件交给 kinemesh_info 确认能解析，再渲染。');
    }

    const resolution = resolveView(request.viewInput, {
      center: loadOutcome.bounds.center,
      radius: loadOutcome.bounds.radius,
      clips: loadOutcome.clips,
    });
    session.warnings.push(...resolution.warnings);
    const baseView = resolution.view;
    await applyBoneLabels(session, request.boneLabels, baseView.mode);
    const azimuths = resolution.orbit8 ? orbit8Azimuths() : [baseView.camera.azimuth];
    const baseName = sanitizeBaseName(request.fileName);

    let index = 0;
    for (const azimuth of azimuths) {
      const view = withAzimuth(baseView, azimuth);
      await applyView(session.page, view);
      for (const frame of frames) {
        if (view.clip !== null) {
          await session.page.evaluate((target) => (window as unknown as BridgeHost).__kinemeshViewer.seekFrame(target), frame);
        }
        const shot = await session.page.screenshot({ type: 'png' });
        const name = `${String(index + 1).padStart(2, '0')}-${baseName}-${view.clip ?? 'static'}-f${frame}-az${Math.round(azimuth)}${view.mode === 'default' ? '' : `-${view.mode}`}.png`;
        const file = path.join(workDir, name);
        await writeFile(file, shot);
        images.push(file);
        index += 1;
      }
    }
  } finally {
    await session.close();
  }
  return { images, warnings: session.warnings };
}

/**
 * B.4 骨骼名标注截图：每批 × 每视角一张 PNG，命名 labels-<view>-<两位批次>.png，写进 outDir。
 * skeleton 模式 + rest 姿态（帧 0）；相机拉远 = 缺省构图 distance = radius × 2.2 近似正交（B.4）。
 * 复用 render 管线的 viewer 页与桥接（setBoneLabels 显式骨骼名清单），批次对齐 skeleton-report。
 */
export async function renderLabelScreenshots(request: LabelShotRequest): Promise<RenderResult> {
  const batches = request.batches.filter((batch) => batch.bones.length > 0);
  const shotCount = batches.length * request.views.length;
  if (shotCount === 0) return { images: [], warnings: [] };
  if (shotCount > MAX_LABEL_SHOTS) {
    throw new KinemeshError(
      `标注截图一次最多 ${MAX_LABEL_SHOTS} 张（本次 ${shotCount}：${batches.length} 批 × ${request.views.length} 视角）。`,
      '骨骼过多的 rig 用 shots:"none" 只出 report，再按批次清单用 kinemesh_render 的 boneLabels 分批出图。',
    );
  }
  const width = clampInt(request.width ?? 1280, 64, 4096);
  const height = clampInt(request.height ?? 720, 64, 4096);
  await mkdir(request.outDir, { recursive: true });

  const session = await openShotPage(width, height);
  const images: string[] = [];
  try {
    const loadOutcome = await loadModelIntoPage(session.page, request.data, request.fileName);
    if (!loadOutcome.ok) {
      throw new KinemeshError(`模型载入失败：${loadOutcome.error}`, '先把文件交给 kinemesh_info 确认能解析，再渲染。');
    }
    for (const batch of batches) {
      const outcome = await session.page.evaluate(
        (payload) => (window as unknown as BridgeHost).__kinemeshViewer.setBoneLabels(payload),
        batch.bones,
      );
      if (outcome.shown === 0) {
        session.warnings.push(`批次 ${batch.batch} 的骨骼名没有命中骨架，该批截图无标签。`);
      }
      for (const viewName of request.views) {
        const resolution = resolveView({ viewPreset: viewName, mode: 'skeleton' }, {
          center: loadOutcome.bounds.center,
          radius: loadOutcome.bounds.radius,
          clips: [],
        });
        session.warnings.push(...resolution.warnings);
        await applyView(session.page, resolution.view);
        const shot = await session.page.screenshot({ type: 'png' });
        const file = path.join(request.outDir, `labels-${viewName}-${String(batch.batch).padStart(2, '0')}.png`);
        await writeFile(file, shot);
        images.push(file);
      }
    }
  } finally {
    await session.close();
  }
  return { images, warnings: session.warnings };
}

// ———————— 内部 ————————

interface BridgeHost {
  __kinemeshViewer: {
    ready(): Promise<void>;
    load(b64: string, fileName: string): Promise<unknown>;
    applyView(view: ViewState): void;
    seekFrame(frame: number): Promise<{ frame: number }>;
    frameInfo(): unknown;
    setBoneLabels(spec: number | 'auto' | 'all' | string[] | null): { shown: number; batches: number; batch: number | 'all' | null };
  };
}

/** 页面桥 load() 的返回形状 */
type LoadOutcome =
  | { ok: true; clips: string[]; bounds: { center: [number, number, number]; radius: number }; durationSeconds: number }
  | { ok: false; error: string };

/** 一次截图会话：独立 viewer 页 + 按次启停的浏览器；warnings 由页面异常等被动事件汇入 */
interface ShotSession {
  page: import('playwright').Page;
  warnings: string[];
  close(): Promise<void>;
}

async function openShotPage(width: number, height: number): Promise<ShotSession> {
  const viewerJs = await readViewerBundle();
  const pageDir = await mkdtemp(path.join(tmpdir(), 'kinemesh-shot-page-'));
  const pageFile = path.join(pageDir, 'viewer.html');
  await writeFile(pageFile, composePage(viewerJs, width, height), 'utf8');
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    const warnings: string[] = [];
    page.on('pageerror', (error) => warnings.push(`页面异常：${error.message}`));
    await page.goto(pathToFileURL(pageFile).href);
    await page.evaluate(() => (window as unknown as BridgeHost).__kinemeshViewer.ready());
    return {
      page,
      warnings,
      close: async () => {
        await browser.close();
        await rm(pageDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    await rm(pageDir, { recursive: true, force: true });
    throw error;
  }
}

async function loadModelIntoPage(
  page: import('playwright').Page,
  data: ArrayBuffer,
  fileName: string,
): Promise<LoadOutcome> {
  const base64 = Buffer.from(data).toString('base64');
  return (await page.evaluate(
    async ({ b64, name }) => {
      const bridge = (window as unknown as { __kinemeshViewer: { load(b64: string, fileName: string): Promise<unknown> } }).__kinemeshViewer;
      return bridge.load(b64, name);
    },
    { b64: base64, name: fileName },
  )) as LoadOutcome;
}

/** B.4：按 boneLabels 入参给页面挂骨骼名标签；仅 skeleton / bones-overlay 模式叠加，其余模式给警告 */
async function applyBoneLabels(
  session: ShotSession,
  spec: number | 'auto' | 'all' | undefined,
  mode: string,
): Promise<void> {
  if (spec === undefined) return;
  if (mode !== 'skeleton' && mode !== 'bones-overlay') {
    session.warnings.push(
      `boneLabels 仅在 mode=skeleton / bones-overlay 下画骨骼名标签（当前 mode=${mode}），本次按无标签渲染。`,
    );
    return;
  }
  const outcome = await session.page.evaluate(
    (payload) => (window as unknown as BridgeHost).__kinemeshViewer.setBoneLabels(payload),
    spec,
  );
  if (outcome.shown === 0) {
    const target = outcome.batch === 'all' ? '"all"' : `批次 ${String(outcome.batch)}`;
    session.warnings.push(`骨骼名标签未画：${target} 没有可标注骨骼（该模型全骨架批数 ${outcome.batches}，批次号 1 起）。`);
  }
}

function withAzimuth(view: ViewState, azimuth: number): ViewState {
  return { ...view, camera: { ...view.camera, azimuth } };
}

async function applyView(page: import('playwright').Page, view: ViewState): Promise<void> {
  await page.evaluate((payload) => (window as unknown as BridgeHost).__kinemeshViewer.applyView(payload), view);
}

/** viewer.js 与 index.js / cli 产物同仓分发。
 *  基准目录：CJS（CLI bundle）用 __filename；ESM（index.js / 源码测试态）用 import.meta.url——
 *  vite 会把 CJS 里的 import.meta.url 编译成空值，所以两条路都要有。从基准目录逐级向上找 viewer.js。 */
function viewerSearchDir(): string | null {
  try {
    return path.dirname(path.resolve(__filename));
  } catch {
    // ESM 态没有 __filename
  }
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

async function readViewerBundle(): Promise<string> {
  const base = viewerSearchDir();
  let dir = base;
  for (let depth = 0; dir !== null && depth < 5; depth += 1) {
    try {
      return await readFile(path.join(dir, 'viewer.js'), 'utf8');
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new KinemeshError(
    '找不到 viewer 产物（viewer.js）。',
    'viewer.js 与插件产物一起构建/分发（npm run build -- --only kinemesh）；插件安装包缺文件时重装插件。',
  );
}

function composePage(viewerJs: string, width: number, height: number): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<style>html,body{margin:0;padding:0;overflow:hidden}#app{width:${width}px;height:${height}px}</style>`,
    '</head>',
    '<body>',
    '<div id="app"></div>',
    `<script>${viewerJs}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

async function loadChromium(): Promise<typeof import('playwright').chromium> {
  try {
    const playwright = await import('playwright');
    return playwright.chromium;
  } catch (error) {
    throw new KinemeshError(
      `本机没有 playwright（${reasonOf(error)}）。`,
      '渲染截图需要 playwright：npm install playwright && npx playwright install chromium；' +
        'DSH 插件出口在缺少它时只提供 kinemesh_info，截图走 CLI/Skill/MCP 出口。',
    );
  }
}

function clampInt(value: number, low: number, high: number): number {
  const parsed = Number.isFinite(value) ? Math.floor(value) : low;
  return Math.min(high, Math.max(low, parsed));
}

function sanitizeBaseName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
  return stem === '' ? 'model' : stem;
}
