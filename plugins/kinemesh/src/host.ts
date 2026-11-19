// Host 半入口：Agent 工具（kinemesh_info / kinemesh_analyze / kinemesh_render）+ /kinemesh 前缀路由。
// 路由五件事：给预览面板供模型字节（GET /kinemesh/model）、供 info JSON（GET /kinemesh/info）、
// 接「发送给 AI 分析」（POST /kinemesh/analyze → agents.followup 唤醒，与 aiworkflow/定时提醒同一机制）、
// 供会话模型清单（GET /kinemesh/session-models，M6e 预览页左列）、供预览曲线数据
// （GET /kinemesh/analysis，M6 core 内存返回 digest/分段/关键帧/能量序列，不落盘）。
// 会话用过的模型记录在内存表（进程内，Host 重启即清空，§6.10.1）。
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { analyzeModel, loadModelScene } from './core/analyze-file.js';
import { sceneBoundsHeight } from './core/analyze/scene-info.js';
import { analyzeClip, type KeyframeEntry, type MotionDigest, type MotionSummary } from './core/motion/analyze.js';
import { computeChannels } from './core/motion/channels.js';
import { sampleClip } from './core/motion/sample.js';
import { resolveNormalization } from './core/motion/normalize.js';
import { loadVocab } from './core/motion/vocab.js';
import { KinemeshError, reasonOf } from './core/errors.js';
import { composeAnalyzeMessage, parseAnalyzeRequest } from './analyze.js';
import { registerTools } from './tools.js';

export const inject = ['webServer', 'tools'];

/** 路由前缀：不以 `/` 结尾（宿主按 `path === prefix || path.startsWith(prefix + '/')` 匹配） */
const ROUTE_PREFIX = '/kinemesh';
/** 路由供模型的体积上限，与 kinemesh_info 的分析上限一致 */
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

export function apply(ctx: any): void {
  ctx.effect(() => registerTools(ctx));
  ctx.effect(() => {
    const sessions = createSessionModels();
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => handleRequest(ctx, sessions, req, res),
    });
    return () => {
      disposeRoute();
    };
  });
}

async function handleRequest(ctx: any, sessions: SessionModels, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const routePath = url.pathname;

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      setCorsHeaders(res);
      res.end();
      return;
    }

    if (routePath === `${ROUTE_PREFIX}/model` && method === 'GET') {
      await serveModel(res, sessions, url.searchParams.get('path') ?? '', url.searchParams.get('sessionId') ?? '');
      return;
    }

    if (routePath === `${ROUTE_PREFIX}/info` && method === 'GET') {
      await serveInfo(res, sessions, url.searchParams.get('path') ?? '', url.searchParams.get('sessionId') ?? '');
      return;
    }

    if (routePath === `${ROUTE_PREFIX}/analysis` && method === 'GET') {
      await serveAnalysis(res, url.searchParams.get('path') ?? '', url.searchParams.get('clip') ?? '');
      return;
    }

    if (routePath === `${ROUTE_PREFIX}/session-models` && method === 'GET') {
      const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
      if (sessionId === '') {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 sessionId 参数。' } });
        return;
      }
      send(res, 200, { ok: true, models: await sessions.list(sessionId) });
      return;
    }

    if (routePath === `${ROUTE_PREFIX}/analyze` && method === 'POST') {
      const body = await readJson(req);
      const parsed = parseAnalyzeRequest(body);
      if (!parsed.ok) {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: parsed.message } });
        return;
      }
      const digest = (body as Record<string, unknown> | null)?.digest;
      const message = composeAnalyzeMessage(parsed.request) + formatDigestSection(digest);
      const delivered = wakeAgent(ctx, parsed.request.sessionId, message);
      if (!delivered) {
        send(res, 409, {
          ok: false,
          error: {
            code: 'agent-offline',
            message:
              '没有找到该会话的在线 Agent（面板与 Agent 不在同一个 Host 进程，或会话 id 不对）。' +
              '把模型路径直接发给 Agent，让它自己调 kinemesh_info / kinemesh_render 也能完成分析。',
          },
        });
        return;
      }
      sessions.record(parsed.request.sessionId, resolveLocal(parsed.request.path));
      send(res, 200, { ok: true, delivered: true });
      return;
    }

    send(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${routePath}` } });
  } catch (error) {
    send(res, 500, { ok: false, error: { code: 'internal', message: reasonOf(error) } });
  }
}

/** GET /kinemesh/model?path=&sessionId=：给预览面板供模型字节；成功即记入会话表（§6.10.4） */
async function serveModel(res: ServerResponse, sessions: SessionModels, rawPath: string, sessionId: string): Promise<void> {
  if (rawPath.trim() === '') {
    send(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 path 参数。' } });
    return;
  }
  const abs = resolveLocal(rawPath);
  const info = await stat(abs).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    send(res, 404, { ok: false, error: { code: 'not-found', message: `文件不存在：${abs}` } });
    return;
  }
  if (info.size > MAX_MODEL_BYTES) {
    send(res, 413, { ok: false, error: { code: 'too-large', message: `文件 ${(info.size / 1024 / 1024).toFixed(0)} MiB 超过预览上限。` } });
    return;
  }
  const data = await readFile(abs);
  sessions.record(sessionId, abs);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-length', data.byteLength);
  res.setHeader('cache-control', 'no-store');
  setCorsHeaders(res);
  res.end(data);
}

/** GET /kinemesh/info?path=&sessionId=：轻量 InfoReport（面板侧栏 / 快速体检）；成功即记入会话表 */
async function serveInfo(res: ServerResponse, sessions: SessionModels, rawPath: string, sessionId: string): Promise<void> {
  if (rawPath.trim() === '') {
    send(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 path 参数。' } });
    return;
  }
  const abs = resolveLocal(rawPath);
  const data = await readFile(abs);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const report = await analyzeModel(buffer, path.basename(abs));
  sessions.record(sessionId, abs);
  send(res, 200, { ok: true, info: report });
}

/** GET /kinemesh/analysis?path=&clip=：预览曲线数据源（§6.10.3）——现场跑 analyzeClip（缺省参数），
 * 内存返回 digest/分段/关键帧/能量序列，不落盘。 */
async function serveAnalysis(res: ServerResponse, rawPath: string, rawClip: string): Promise<void> {
  if (rawPath.trim() === '') {
    send(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 path 参数。' } });
    return;
  }
  const abs = resolveLocal(rawPath);
  const info = await stat(abs).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    send(res, 404, { ok: false, error: { code: 'not-found', message: `文件不存在：${abs}` } });
    return;
  }
  const data = await readFile(abs);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const clip = rawClip.trim();
  try {
    const result = await analyzeInMemory(buffer, path.basename(abs), clip === '' ? undefined : clip, path.dirname(abs));
    send(res, 200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof KinemeshError) {
      send(res, 400, { ok: false, error: { code: 'analyze-failed', message: `${error.message}${error.guidance}` } });
      return;
    }
    throw error;
  }
}

/** GET /kinemesh/analysis 的返回体（§6.10.3）：digest + 分段 + 关键帧 + 曲线序列 */
export interface PreviewAnalysis {
  summaryDigest: MotionDigest;
  segments: MotionSummary['segments'];
  keyframes: KeyframeEntry[];
  /** 采样帧号（channels.frames，x 轴口径） */
  frames: number[];
  /** 加权平均关节线速度（channels.energy，H/s）——与 motion-frames.csv 的 energy 列同源 */
  energy: number[];
}

/**
 * 预览页曲线数据源（§6.10.3）：与 kinemesh_analyze 的 runAnalyze 走同一条管线
 * （加载场景 → 身高归一 → vocab 发现 → analyzeClip），energy 直接取同一通道计算
 * （computeChannels）的序列——同一段代码，保证「曲线数值与中间文件一致」（§6.9 M6e 验收）。
 * analyzeClip 与 sampleClip 都是确定性纯函数，digest 与 energy 两次采样结果逐位一致。
 */
async function analyzeInMemory(
  data: ArrayBuffer,
  fileName: string,
  clip: string | undefined,
  assetDir: string,
): Promise<PreviewAnalysis> {
  const { scene } = await loadModelScene(data, fileName);
  const normalization = resolveNormalization('height', sceneBoundsHeight(scene));
  const vocab = await loadVocab({ assetDir, cwd: process.cwd() });
  const analysis = analyzeClip(scene, {
    clipName: clip,
    scale: normalization.scale,
    normalizeMode: 'height',
    vocab,
  });
  const sample = sampleClip(scene, { clipName: clip });
  const channels = computeChannels(sample, { scale: normalization.scale });
  return {
    summaryDigest: analysis.digest,
    segments: analysis.summary.segments,
    keyframes: analysis.summary.keyframes,
    frames: channels.frames,
    energy: channels.energy,
  };
}

// ———————— 会话模型表（§6.10.1：sessionId → 有序去重路径表，内存、不持久化） ————————

/** GET /kinemesh/session-models 的条目：路径 + 轻量信息（文件名/是否有动画/clip 清单/体积） */
export interface SessionModelEntry {
  path: string;
  name: string;
  animated: boolean;
  clips: string[];
  bytes: number;
}

/** 进程内会话模型表：analyze/render/info 路由处理成功时记录，预览页打开时拉取 */
export interface SessionModels {
  record(sessionId: string, absPath: string): void;
  list(sessionId: string): Promise<SessionModelEntry[]>;
}

function createSessionModels(): SessionModels {
  const pathsBySession = new Map<string, string[]>();
  const clipCache = new Map<string, { animated: boolean; clips: string[] }>();
  return {
    record(sessionId: string, absPath: string): void {
      const id = sessionId.trim();
      const target = absPath.trim();
      if (id === '' || target === '') return;
      const list = pathsBySession.get(id);
      if (list === undefined) pathsBySession.set(id, [target]);
      else if (!list.includes(target)) list.push(target);
    },
    async list(sessionId: string): Promise<SessionModelEntry[]> {
      const paths = pathsBySession.get(sessionId.trim()) ?? [];
      const models: SessionModelEntry[] = [];
      for (const abs of paths) {
        const info = await stat(abs).catch(() => undefined);
        if (info === undefined || !info.isFile()) continue;
        let clips = clipCache.get(abs);
        if (clips === undefined) {
          clips = await clipInfoOf(abs);
          clipCache.set(abs, clips);
        }
        models.push({ path: abs, name: path.basename(abs), animated: clips.animated, clips: clips.clips, bytes: info.size });
      }
      return models;
    },
  };
}

/** 轻量 clip 信息（是否动画/clip 清单）；解析失败按无动画处理，不阻塞清单返回 */
async function clipInfoOf(abs: string): Promise<{ animated: boolean; clips: string[] }> {
  try {
    const data = await readFile(abs);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const report = await analyzeModel(buffer, path.basename(abs));
    return { animated: report.clips.length > 0, clips: report.clips.map((clip) => clip.name) };
  } catch {
    return { animated: false, clips: [] };
  }
}

/**
 * 「发送给 AI 分析」消息的 digest 段（§6.10：把当前 summaryDigest 附进消息）。
 * 防御式读取 JSON 字段；无有效内容返回空串（消息保持 M3 原样）。
 */
export function formatDigestSection(digest: unknown): string {
  if (typeof digest !== 'object' || digest === null) return '';
  const raw = digest as {
    clip?: { name?: unknown; duration?: unknown; frames?: unknown } | null;
    segments?: unknown;
    loopCheck?: { verdict?: unknown; bestLoopRange?: { frameStart?: unknown; frameEnd?: unknown } | null } | null;
    facts?: unknown;
    keyframeRender?: { frames?: unknown; views?: unknown; mode?: unknown } | null;
  };
  const body: string[] = [];
  const clipName = typeof raw.clip?.name === 'string' ? raw.clip.name : '';
  if (clipName !== '') {
    const duration = typeof raw.clip?.duration === 'number' ? `${raw.clip.duration.toFixed(2)}s` : '';
    const frames = typeof raw.clip?.frames === 'number' ? `${raw.clip.frames} 帧@30fps` : '';
    body.push(`clip「${clipName}」${[duration, frames].filter(Boolean).join('，')}`);
  }
  const segments = Array.isArray(raw.segments) ? (raw.segments as Array<Record<string, unknown>>) : [];
  if (segments.length > 0) {
    body.push('分段：');
    for (const segment of segments) {
      body.push(
        `  ${String(segment.index ?? '')}. frame ${String(segment.frameStart ?? '?')}–${String(segment.frameEnd ?? '?')}：` +
          `${String(segment.label ?? '')}，guess ${String(segment.guess ?? '')}，强度 ${String(segment.level ?? '')}`,
      );
    }
  }
  const verdict = typeof raw.loopCheck?.verdict === 'string' ? raw.loopCheck.verdict : '';
  if (verdict !== '') {
    const range = raw.loopCheck?.bestLoopRange;
    const rangeText =
      range !== null && typeof range === 'object'
        ? `，bestLoopRange 采样帧 ${String(range.frameStart)}–${String(range.frameEnd)}`
        : '';
    body.push(`循环检测：${verdict}${rangeText}`);
  }
  const facts = Array.isArray(raw.facts) ? raw.facts.filter((fact): fact is string => typeof fact === 'string') : [];
  if (facts.length > 0) {
    body.push('事实：', ...facts.map((fact) => `  - ${fact}`));
  }
  const recipe = raw.keyframeRender;
  if (recipe !== null && typeof recipe === 'object') {
    const frames = Array.isArray(recipe.frames) ? recipe.frames.map(String).join(', ') : '';
    const views = Array.isArray(recipe.views) ? recipe.views.map(String).join('/') : '';
    body.push(`keyframeRender 配方：frames [${frames}]，views ${views}，mode ${String(recipe.mode ?? '')}（原样传给 kinemesh_render）`);
  }
  if (body.length === 0) return '';
  return `\n\n【动作分析 digest】（kinemesh_analyze 同源数值，直接引用、无需重新分析）\n${body.join('\n')}`;
}

/**
 * 唤醒绑定的 Agent（与 aiworkflow / 定时提醒同一套机制：followup 一条用户态消息）。
 * 返回 false 表示 Agent 不在线（路由层回 409 并给自愈文案）。
 */
function wakeAgent(ctx: any, sessionId: string, message: string): boolean {
  try {
    const agent = ctx?.get?.('agents')?.get?.(sessionId) as { followup?: (message: unknown) => void } | undefined;
    if (agent === undefined || typeof agent.followup !== 'function') return false;
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: message }],
      source: { kind: 'schedule' },
    });
    return true;
  } catch {
    return false;
  }
}

/** ~ 与相对路径的解析（相对宿主进程 cwd） */
function resolveLocal(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.join(homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  setCorsHeaders(res);
  res.end(text);
}

/**
 * 跨源放行（同 aiworkflow）：页面可能来自 `dsh web`（同源无需 CORS），
 * 也可能来自桌面壳 file:// 渲染器（源为 null），后者必须显式允许。
 */
function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'accept, content-type');
  res.setHeader('access-control-max-age', '600');
}
