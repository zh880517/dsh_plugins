// Host 半入口：Agent 工具（kinemesh_info / kinemesh_render）+ /kinemesh 前缀路由。
// 路由三件事：给预览面板供模型字节（GET /kinemesh/model）、供 info JSON（GET /kinemesh/info）、
// 接「发送给 AI 分析」（POST /kinemesh/analyze → agents.followup 唤醒，与 aiworkflow/定时提醒同一机制）。
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { analyzeModel } from './core/analyze-file.js';
import { reasonOf } from './core/errors.js';
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
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => handleRequest(ctx, req, res),
    });
    return () => {
      disposeRoute();
    };
  });
}

async function handleRequest(ctx: any, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      await serveModel(res, url.searchParams.get('path') ?? '');
      return;
    }

    if (routePath === `${ROUTE_PREFIX}/info` && method === 'GET') {
      await serveInfo(res, url.searchParams.get('path') ?? '');
      return;
    }

    if (routePath === `${ROUTE_PREFIX}/analyze` && method === 'POST') {
      const body = await readJson(req);
      const parsed = parseAnalyzeRequest(body);
      if (!parsed.ok) {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: parsed.message } });
        return;
      }
      const delivered = wakeAgent(ctx, parsed.request.sessionId, composeAnalyzeMessage(parsed.request));
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
      send(res, 200, { ok: true, delivered: true });
      return;
    }

    send(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${routePath}` } });
  } catch (error) {
    send(res, 500, { ok: false, error: { code: 'internal', message: reasonOf(error) } });
  }
}

/** GET /kinemesh/model?path=…：给预览面板供模型字节 */
async function serveModel(res: ServerResponse, rawPath: string): Promise<void> {
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
  res.statusCode = 200;
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-length', data.byteLength);
  res.setHeader('cache-control', 'no-store');
  setCorsHeaders(res);
  res.end(data);
}

/** GET /kinemesh/info?path=…：轻量 InfoReport（面板侧栏 / 快速体检） */
async function serveInfo(res: ServerResponse, rawPath: string): Promise<void> {
  if (rawPath.trim() === '') {
    send(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 path 参数。' } });
    return;
  }
  const abs = resolveLocal(rawPath);
  const data = await readFile(abs);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const report = await analyzeModel(buffer, path.basename(abs));
  send(res, 200, { ok: true, info: report });
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
