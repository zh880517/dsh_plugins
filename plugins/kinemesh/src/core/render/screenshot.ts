// 截图管线（设计文档 §4.5）：Playwright(chromium) + 内嵌 viewer 的独立 HTML。
// 浏览器进程按次启停，不做常驻服务（红线）。输入模型字节 + ViewState，输出 PNG 绝对路径数组。
// viewer.js 是构建期从 src/viewer-page.ts 打出的 IIFE（scripts/build-plugin.mjs 通用第三产物），
// 与插件产物一起分发；本模块在运行时把它内联进 HTML，不依赖 node_modules 里有 three。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
}

export interface RenderResult {
  /** PNG 绝对路径（按渲染顺序） */
  images: string[];
  warnings: string[];
}

const MAX_FRAMES = 64;
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

  const viewerJs = await readViewerBundle();
  const workDir = path.join(request.outDir ?? path.join(tmpdir(), 'kinemesh-shots'), `run-${Date.now()}-${process.pid}`);
  await mkdir(workDir, { recursive: true });
  const pageFile = path.join(workDir, 'viewer.html');
  await writeFile(pageFile, composePage(viewerJs, width, height), 'utf8');

  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  const warnings: string[] = [];
  const images: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.on('pageerror', (error) => warnings.push(`页面异常：${error.message}`));

    await page.goto(pathToFileURL(pageFile).href);
    await page.evaluate(() => (window as unknown as { __kinemeshViewer: { ready(): Promise<void> } }).__kinemeshViewer.ready());

    const base64 = Buffer.from(request.data).toString('base64');
    const loadOutcome = (await page.evaluate(
      async ({ b64, fileName }) => {
        const bridge = (window as unknown as { __kinemeshViewer: { load(b64: string, fileName: string): Promise<unknown> } }).__kinemeshViewer;
        return bridge.load(b64, fileName);
      },
      { b64: base64, fileName: request.fileName },
    )) as LoadOutcome;
    if (!loadOutcome.ok) {
      throw new KinemeshError(`模型载入失败：${loadOutcome.error}`, '先把文件交给 kinemesh_info 确认能解析，再渲染。');
    }

    const resolution = resolveView(request.viewInput, {
      center: loadOutcome.bounds.center,
      radius: loadOutcome.bounds.radius,
      clips: loadOutcome.clips,
    });
    warnings.push(...resolution.warnings);
    const baseView = resolution.view;
    const azimuths = resolution.orbit8 ? orbit8Azimuths() : [baseView.camera.azimuth];
    const baseName = sanitizeBaseName(request.fileName);

    let index = 0;
    for (const azimuth of azimuths) {
      const view = withAzimuth(baseView, azimuth);
      await applyView(page, view);
      for (const frame of frames) {
        if (view.clip !== null) {
          await page.evaluate((target) => (window as unknown as BridgeHost).__kinemeshViewer.seekFrame(target), frame);
        }
        const shot = await page.screenshot({ type: 'png' });
        const name = `${String(index + 1).padStart(2, '0')}-${baseName}-${view.clip ?? 'static'}-f${frame}-az${Math.round(azimuth)}${view.mode === 'default' ? '' : `-${view.mode}`}.png`;
        const file = path.join(workDir, name);
        await writeFile(file, shot);
        images.push(file);
        index += 1;
      }
    }
  } finally {
    await browser.close();
  }
  return { images, warnings };
}

// ———————— 内部 ————————

interface BridgeHost {
  __kinemeshViewer: {
    ready(): Promise<void>;
    load(b64: string, fileName: string): Promise<unknown>;
    applyView(view: ViewState): void;
    seekFrame(frame: number): Promise<{ frame: number }>;
    frameInfo(): unknown;
  };
}

/** 页面桥 load() 的返回形状 */
type LoadOutcome =
  | { ok: true; clips: string[]; bounds: { center: [number, number, number]; radius: number }; durationSeconds: number }
  | { ok: false; error: string };

function withAzimuth(view: ViewState, azimuth: number): ViewState {
  return { ...view, camera: { ...view.camera, azimuth } };
}

async function applyView(page: import('playwright').Page, view: ViewState): Promise<void> {
  await page.evaluate((payload) => (window as unknown as BridgeHost).__kinemeshViewer.applyView(payload), view);
}

/** viewer.js 与 index.js 同目录（构建产物一起分发）。
 *  源码态（vitest/typecheck）import.meta.url 在 src/core/render/ 下，运行态在插件根 index.js——
 *  逐级向上探测，两边都能找到。 */
async function readViewerBundle(): Promise<string> {
  for (const relative of ['./viewer.js', '../viewer.js', '../../viewer.js', '../../../viewer.js']) {
    const candidate = new URL(relative, import.meta.url);
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      // 试下一个层级
    }
  }
  throw new KinemeshError(
    '找不到 viewer 产物（viewer.js）。',
    'viewer.js 与 index.js 一起构建/分发（npm run build -- --only kinemesh）；插件安装包缺文件时重装插件。',
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
