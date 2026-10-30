// `GET /handoff/draft?session=<id>`：为「开启新会话交接」生成交接单，**不写任何东西**
// （design.md §2 / §3.2 / §10 T8）。
//
// 守卫与摘要和 `/handoff` 是同一份（handoff.ts 的 `prepareHandoff`）；拿到交接单之后这里
// 直接返回，不备份、不 append、不建 session —— 由 Client 拿去 `sessionManager.create`
// 开新会话（design.md §5 / T10）。
//
// **刻意不做「选区稳定」检查（`/handoff` 的守卫 C）。** 新会话交接只是把这段文本当作新
// 会话的首条 prompt，旧会话一个字节都不动；摘要期间 surface 变了，草稿就是基于变化前
// 快照生成的，这对新会话场景无害（最多是少记了最后一步，而旧会话还在、可以再交接一次）。
// `/handoff` 则必须放弃：它要拿同一份文档去 replace 那段 surface，快照与替换区间不一致
// 会遮蔽错东西。所以稳定性检查留在 command.ts，不放进共用管线。
//
// 这里只做「查 session / agent → 共用守卫与摘要 → 映射成 HTTP 状态」；req/res 的细节
// 留在 host.ts，单测可以直接喂假 ctx（tests/handoff/draft.test.ts）。

import {
  HANDOFF_TEXTS,
  isAborted,
  prepareHandoff,
  reasonOf,
  type HandoffSessionView,
  type HandoffStage,
} from './handoff.js';
import type { HandoffSummarizeAgent, HandoffSummarizeContext } from './summarize.js';

/**
 * 失败码：HTTP 层的稳定契约。
 *
 * Client（T9/T10）只展示 `error.message`，但测试、日志与将来的重试逻辑按 `code` 分支。
 *
 * `not-found` / `method-not-allowed` 是**路由层**错误码（host.ts 的 404 / 405），
 * 不会从 `runHandoffDraft` 返回，但同属这条路由的响应契约，一并列在这里。
 */
export type HandoffDraftErrorCode =
  | 'bad-request'
  | 'session-not-found'
  | 'agent-not-live'
  | 'busy'
  | 'cancelled'
  | 'summary-failed'
  | 'internal'
  | 'not-found'
  | 'method-not-allowed';

/** 成功体：`doc` 是完整交接单（**含** §6 的头部注释）。 */
export interface HandoffDraftSuccess {
  readonly ok: true;
  /** 完整交接单；没有可交接的历史时为 `null`（`shadowable` 同时为 0）。 */
  readonly doc: string | null;
  /** 被遮蔽（= 被交接）的节点数；0 表示没有可交接的历史。 */
  readonly shadowable: number;
}

/** 失败体：与 aiworkflow 的 `{ ok: false, error: { code, message } }` 同形。 */
export interface HandoffDraftFailure {
  readonly ok: false;
  readonly error: { readonly code: HandoffDraftErrorCode; readonly message: string };
}

/** 响应 JSON 体。 */
export type HandoffDraftBody = HandoffDraftSuccess | HandoffDraftFailure;

/** draft 的完整结果：状态码 + JSON 体（host.ts 只负责把它写进 `res`）。 */
export interface HandoffDraftResponse {
  readonly status: number;
  readonly body: HandoffDraftBody;
}

/** `ctx.sessions` 里 draft 用到的一点（`dsh-session` 的 `SessionStore`）。 */
export interface HandoffDraftSessions {
  /** 按 id 取**活跃**会话；没有就返回 `undefined`（不读持久化、不 resume）。 */
  get(id: string): unknown;
}

/**
 * Host 上下文里 draft 用到的部分。
 *
 * `get` 是 Cordis 的服务查找（`ctx.get('agents')`），与 aiworkflow 的 host.ts 用法一致：
 * `agents` 不在 `inject` 里，缺少该服务的组合也不会让整个插件失效。
 */
export interface HandoffDraftContext extends HandoffSummarizeContext {
  readonly sessions: HandoffDraftSessions;
  get?(name: string): unknown;
}

/**
 * 真实 Agent 的最小视图：摘要要的字段（`session.requestHeader` / `options`）+ 只读会话。
 *
 * 这是**真实** Agent 的结构类型，不是伪造对象：`ctx.get('agents').get(id)` 返回的 live
 * Agent 上正好挂着 `session` 与 `options`（`dsh-agent` 的 runtime-types）。
 */
export type HandoffDraftAgent = HandoffSummarizeAgent & {
  readonly session: HandoffSessionView;
};

/** 失败结果的小工厂。 */
function failure(status: number, code: HandoffDraftErrorCode, message: string): HandoffDraftResponse {
  return { status, body: { ok: false, error: { code, message } } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** 结构检查：只认 `HandoffSessionView` 需要的那几个成员，形状不对就当没有。 */
function isSessionView(value: unknown): value is HandoffSessionView {
  const record = asRecord(value);
  if (record === undefined) return false;
  return (
    typeof record['id'] === 'string' &&
    typeof record['seq'] === 'number' &&
    asRecord(record['surface']) !== undefined &&
    typeof record['eventAt'] === 'function' &&
    typeof record['deriveMessages'] === 'function'
  );
}

/**
 * 按 id 找活跃 Agent：`ctx.get('agents')` 是 `dsh-agent` 的 `AgentRegistry`，`get(id)`
 * 返回 live `Agent`（Agent 上带 `session` 与 `options`，正是摘要需要的两样）。
 *
 * 拿不到 agents 服务、服务里没有这个会话、或形状不对时返回 `undefined`，不抛。
 */
function findAgent(ctx: HandoffDraftContext, sessionId: string): HandoffDraftAgent | undefined {
  try {
    const agents = asRecord(ctx.get?.('agents'));
    const get = agents?.['get'];
    if (typeof get !== 'function') return undefined;
    const agent = (get as (this: unknown, id: string) => unknown).call(agents, sessionId);
    const record = asRecord(agent);
    if (record === undefined || !isSessionView(record['session'])) return undefined;
    return agent as HandoffDraftAgent;
  } catch {
    return undefined;
  }
}

/** 按 id 找 live Session：`ctx.sessions` 是 `dsh-session` 的 `SessionStore`。 */
function findSession(ctx: HandoffDraftContext, sessionId: string): HandoffSessionView | undefined {
  try {
    const session = ctx.sessions.get(sessionId);
    return isSessionView(session) ? session : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 生成一份新会话交接草稿：只读，**不写会话、不建 session、不写备份**（design.md §3.2）。
 *
 * @param ctx - 宿主上下文（`llm` / `sessions` / `get('agents')`）。
 * @param sessionId - 源会话 id（URL 的 `?session=`，原始 DSH 会话 id）。
 * @param signal - 可选取消信号（HTTP 层在客户端断开时 abort）。
 * @returns 状态码 + JSON 体；不会抛异常（兜底折成 500 `internal`）。
 */
export async function runHandoffDraft(
  ctx: HandoffDraftContext,
  sessionId: string,
  signal?: AbortSignal,
): Promise<HandoffDraftResponse> {
  const id = sessionId.trim();
  if (id === '') return failure(400, 'bad-request', '需要 session 参数（会话 id）。');
  if (isAborted(signal)) return failure(499, 'cancelled', HANDOFF_TEXTS.cancelled);

  // 先 Agent 再 Session：Agent 上的 session 一定是我们能摘要的那份 live 会话；只有找不到
  // Agent 时才退回 SessionStore 判断"会话到底存不存在"（决定 404 还是 409）。
  //
  // 不 resume 冷会话：`ctx.sessionController.resolveAgent` 会挂载 Agent、落持久化事件，
  // 与"草稿不写任何东西"直接冲突。所以 HTTP 入口只服务当前活跃会话，这也是按钮的真实场景。
  const agent = findAgent(ctx, id);
  const session = agent?.session ?? findSession(ctx, id);
  if (session === undefined) return failure(404, 'session-not-found', `找不到活跃会话 ${id}。`);
  if (agent === undefined) {
    return failure(409, 'agent-not-live', `会话 ${id} 没有活跃的 Agent（摘要需要它的模型路由），无法生成交接单。`);
  }

  let stage: HandoffStage;
  try {
    stage = await prepareHandoff(ctx, session, agent, signal);
  } catch (error) {
    // 兜底：surface / 事件读取等意外路径（与 `/handoff` 的兜底文案同一用途）。
    return failure(500, 'internal', `交接单生成失败：${reasonOf(error)}。`);
  }

  switch (stage.kind) {
    case 'busy': {
      return failure(409, 'busy', HANDOFF_TEXTS.busy);
    }
    case 'no-history': {
      // 没有可交接的历史：路由本身成功，但没有 doc —— Client 据此提示并停在原会话
      // （不要拿空文本去建新会话）。
      return { status: 200, body: { ok: true, doc: null, shadowable: 0 } };
    }
    case 'cancelled': {
      // 客户端已断开时通常来不及写回（host.ts 会跳过）；这里保留完整结果便于单测与日志。
      return failure(499, 'cancelled', HANDOFF_TEXTS.cancelled);
    }
    case 'summary-failed': {
      return failure(502, 'summary-failed', HANDOFF_TEXTS.summaryFailed);
    }
    case 'ready': {
      // 这里**不**做选区稳定检查：草稿基于摘要前的快照，旧会话没被改，见文件头说明。
      return { status: 200, body: { ok: true, doc: stage.doc, shadowable: stage.shadowable } };
    }
  }
}
