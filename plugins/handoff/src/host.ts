// Host 半入口：`/handoff` 命令与 `GET /handoff/draft` 路由的注册与生命周期。
//
// 命令形状照抄 `@deepseek-ai/dsh-command-compact`（design.md §4.1）：`active` 集合保证
// 插件卸载时等所有进行中的交接结算，命令注册放在 `ctx.effect` 里，随插件卸载一起撤销。
//
// 路由照 aiworkflow 的 host.ts：同源 `ctx.webServer` + 插件前缀 `/handoff/draft`，
// 并且和它一样处理 CORS —— 桌面壳用 `file://` 载入渲染器时页面源是 `null`。
//
// 真正的流程在两处：命令在 command.ts，草稿在 draft.ts（共用 handoff.ts 的守卫与摘要）。

import type { IncomingMessage, ServerResponse } from 'node:http';

import { runHandoff, type HandoffCommandResult, type HandoffInvocation } from './command.js';
import { runHandoffDraft, type HandoffDraftContext, type HandoffDraftResponse } from './draft.js';
import { reasonOf } from './handoff.js';

export type { HandoffCommandResult, HandoffInvocation };

/**
 * 注入的服务。
 *
 * `webServer` 是 P2 追加的（design.md §4.1）：没有 Web 服务的组合里本插件不激活，
 * 也就没有 `/handoff` 命令 —— 这是设计上接受的取舍（P2 的按钮只存在于 Web/桌面壳）。
 * `sessions` 用来按 id 找 live 会话；`agents` 不做 inject，走 `ctx.get('agents')`
 * （aiworkflow 同款），缺它时命令照常、draft 返回 409。
 */
export const inject = ['commands', 'sessions', 'llm', 'webServer'];

/** 路由前缀：不以 `/` 结尾（宿主按 `path === prefix || path.startsWith(prefix + '/')` 匹配）。 */
const ROUTE_PREFIX = '/handoff/draft';

/**
 * 注册 `/handoff` 与 `/handoff/draft`，并在卸载时等待进行中的交接结算。
 * @param ctx - 宿主上下文（`commands` / `sessions` / `llm` / `webServer` 已注入）。
 */
export function apply(ctx: any): void {
  const active = new Set<Promise<unknown>>();
  /** 在飞的取消控制器（draft 等）：卸载时先 abort 再 drain，别让不响应 signal 的适配器拖住退出。 */
  const controllers = new Set<AbortController>();
  /**
   * 记入 `active`，让插件卸载时等这次交接结算（命令与草稿共用）。
   * @param operation - 进行中的交接。
   * @returns 原样的 promise。
   */
  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    const retire = (): void => {
      active.delete(operation);
    };
    operation.then(retire, retire);
    return operation;
  };
  const handler = (invocation: HandoffInvocation): Promise<HandoffCommandResult> =>
    track(runHandoff(ctx, invocation));
  ctx.effect(function* () {
    // 这个 cleanup 先被 yield（LIFO 下最后执行）：先 abort 在飞的请求，再等它们结算。
    yield async () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
      await Promise.allSettled(active);
    };
    yield ctx.commands.register({
      // 与 DSH 自家命令一致（`@deepseek-ai/dsh-command-compact` 等用完整包名作
      // definitionId）；`name` 才是用户敲的 `/handoff`，两者不是一回事。
      definitionId: '@handoff/dsh-plugin',
      name: 'handoff',
      description: 'Replace this conversation with a handoff document',
      handler,
    });
  }, 'handoff lifecycle');

  // 路由单独一个 effect：它和命令注册互不依赖，卸载时各自撤销。
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) =>
        handleDraftRequest(ctx, req, res, track, controllers),
    });
    return () => {
      disposeRoute();
    };
  }, 'handoff draft route');
}

/** `track` 的形状：把一条进行中的交接记进 `apply` 的 `active` 集合。 */
type Track = <T>(operation: Promise<T>) => Promise<T>;

/**
 * `GET /handoff/draft?session=<sessionId>`：只读草稿。
 *
 * HTTP 细节（CORS / 状态码 / JSON 形状 / 客户端断开）都在这里，业务在 draft.ts，
 * 这样单测可以直接喂假 ctx / 假 req / 假 res。
 */
async function handleDraftRequest(
  ctx: any,
  req: IncomingMessage,
  res: ServerResponse,
  track: Track,
  controllers: Set<AbortController>,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      setCorsHeaders(req, res);
      res.end();
      return;
    }

    // 前缀路由会把 `/handoff/draft/*` 也送进来：只认这一个端点。
    if (url.pathname !== ROUTE_PREFIX && url.pathname !== `${ROUTE_PREFIX}/`) {
      sendNotFound(req, res, url.pathname);
      return;
    }

    if (method !== 'GET') {
      sendJson(req, res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } });
      return;
    }

    // 客户端断开（关页面 / 取消请求）时中止进行中的摘要，别让一次没人要的
    // 模型调用继续跑；`res` 已经写完则不算断开。控制器同时进 `apply` 的集合，
    // 插件卸载时会被先 abort（见 apply 里的 cleanup）。
    const controller = new AbortController();
    controllers.add(controller);
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    if (typeof res.on === 'function') res.on('close', onClose);

    let result: HandoffDraftResponse;
    try {
      result = await track(
        runHandoffDraft(ctx as HandoffDraftContext, url.searchParams.get('session') ?? '', controller.signal),
      );
    } finally {
      controllers.delete(controller);
      if (typeof res.off === 'function') res.off('close', onClose);
    }

    // 客户端已经走了：响应没人收，写它只会在已销毁的 socket 上报错。
    if (controller.signal.aborted && res.destroyed) return;
    sendJson(req, res, result.status, result.body);
  } catch (error) {
    sendJson(req, res, 500, { ok: false, error: { code: 'internal', message: reasonOf(error) } });
  }
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  setCorsHeaders(req, res);
  res.end(text);
}

function sendNotFound(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  sendJson(req, res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${pathname}` } });
}

/**
 * 只读本地数据的跨源放行，按 `Origin` 分层（不按 remoteAddress 白名单，那会打断局域网用法）：
 *
 * - 没有 `Origin`（同源请求 / 非浏览器）→ 不设 ACAO（同源本来不受 CORS 限制）；
 * - `Origin: null`（桌面壳 `file://` 渲染器）→ `ACAO: null`；
 * - `Origin` 的 host 与 `req.headers.host` 相同 → 回显该 origin；
 * - 其它（陌生网页）→ 不设 ACAO，浏览器读不到响应体。
 *
 * 这条 GET 会返回会话摘要正文并触发一次付费 LLM 调用，所以不能再 `*`。
 */
function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (origin === undefined || origin === '') return;

  let allow: string | undefined;
  if (origin === 'null') {
    allow = 'null';
  } else {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    const requestHost = req.headers.host;
    if (originHost !== undefined && typeof requestHost === 'string' && originHost === requestHost) {
      allow = origin;
    }
  }
  if (allow === undefined) return;

  res.setHeader('access-control-allow-origin', allow);
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'accept, content-type');
  res.setHeader('access-control-max-age', '600');
}
