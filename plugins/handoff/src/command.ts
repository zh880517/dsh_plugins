// `/handoff` 执行体：守卫 → 摘要 → 备份 → 替换 → 文案（design.md §4.3 / §4.4 / §4.5）。
//
// 守卫与摘要是两个入口共用的（handoff.ts）；这里只做 `/handoff` 独有的一段：
// 选区稳定检查 → 备份 → replace。draft 路由（draft.ts）拿到同一个交接单后直接返回。
//
// 顺序是刻意的（design.md §4.3）：备份是唯一不可撤销的前置写操作，写不成就绝不
// append（fail closed）；append 之前再确认一次 surface 没变。
//
// 只 import 本目录内的相对路径（带 `.js`）与 `node:` 内建：DSH 的包不是本仓库的依赖，
// 真实 Session / Agent / `ctx.llm` 全部用最小结构化接口描述，单测直接传假对象
// （tests/handoff/command.test.ts），不需要伪造整个宿主。

import { randomUUID } from 'node:crypto';

import { writeBackup } from './backup.js';
import {
  HANDOFF_TEXTS,
  isAborted,
  prepareHandoff,
  reasonOf,
  surfaceViews,
  type HandoffSessionView,
} from './handoff.js';
import type { HandoffSummarizeAgent, HandoffSummarizeContext } from './summarize.js';

// `surfaceViews` 与事件视图现在住在 handoff.ts；这里转出去，保住 command.ts 原有的
// 公开面（command.test.ts 直接 import 它）。
export { surfaceViews } from './handoff.js';
export type { HandoffEventView, HandoffSessionView } from './handoff.js';

/** 命令返回值（宿主 `commands.register` 的 CommandResult 形状，design.md §4.5）。 */
export interface HandoffCommandResult {
  readonly kind: 'success' | 'error';
  readonly text?: string | undefined;
  /** append 之后的事件 seq，供 UI 定位；失败时没有。 */
  readonly sourceEventSeq?: number | undefined;
}

/**
 * `/handoff` 的调用现场（宿主 `commands` 服务构造）。
 *
 * 只列本命令会碰到的字段；真实对象由 `dsh-commands` 的 `execute()` 构造，是它的超集。
 */
export interface HandoffInvocation {
  readonly commandId: string;
  /** 当前 Agent；用它拿 `session`（surface / 事件日志 / append）与模型路由。 */
  readonly agent: unknown;
  /** `/handoff` 之后的原始输入；本命令不接受参数。 */
  readonly rawInput: string;
  /** UI 请求的取消信号。 */
  readonly signal: AbortSignal;
}

/**
 * 一条 `user/message` 的 payload（`dsh-llm` 的 `UserMessage` 形状，只列本命令写的字段）。
 *
 * **`id` 是必需的**：`Session.append` 接受 payload 时不查它，但恢复会话时
 * `adoptSessionEvent` 会拒绝没有稳定 id 的 message（"lacks an identified message"），
 * 也就是说省掉它会把会话写成**下次加载失败**的日志。design.md §4.3 的示意片段没有写
 * `id`，实现里补一个 `randomUUID()`（与 `dsh-llm` 的 `createUserMessage` 一致）。
 */
export interface HandoffUserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly source: { readonly kind: string };
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
}

/** append 的 surface 元数据：`replace` 区间 + 被遮蔽节点的完整 seq 列表。 */
export interface HandoffAppendOptions {
  readonly surfaceOp: { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number };
  readonly sourceEventSeqs: readonly number[];
}

/** `Session` 里 `/handoff` 用到的部分（真实 Session 是它的超集）。 */
export interface HandoffSession extends HandoffSessionView {
  append(type: 'user/message', data: HandoffUserMessage, opts: HandoffAppendOptions): { readonly seq: number };
}

/** Host 上下文里本模块用到的部分：摘要要的 `ctx.llm` 就是它的全部。 */
export type HandoffContext = HandoffSummarizeContext;

/**
 * 替换消息的引导语：告诉读这条消息的模型"此前对话已被这份交接单取代"。
 *
 * 与压缩的 checkpoint 引导语同一个用途（design.md §4.3）；`<handoff>` 包裹段由本模块
 * 拼接，备份文件里**不带**这层包裹（备份只有交接单原文）。
 */
export const PREAMBLE = `This conversation was handed off: everything before this message has been replaced by the handoff document below.
Treat it as established background, including its "下一步" (next steps), and continue the work from there.
Do not ask the user to restate anything the document already records.`;

/** 调用的 Agent 里取出 session；形状不对属于宿主接线错误，交给外层兜底。 */
function sessionOf(agent: unknown): HandoffSession {
  const candidate =
    agent !== null && typeof agent === 'object' ? (agent as { readonly session?: unknown }).session : undefined;
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('调用现场没有关联的会话');
  }
  return candidate as HandoffSession;
}

/** surface 快照比较：守卫 C 用（design.md §4.4）。 */
function sameNodes(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((seq, index) => seq === right[index]);
}

/**
 * 执行一次 `/handoff`：守卫 → 摘要 → 备份 → 替换（design.md §4.3）。
 *
 * 任何失败都收敛成 `{ kind: 'error', text }`，**不向宿主抛异常**（design.md §4.5）。
 *
 * @param ctx - 宿主上下文（只需 `llm.stream`）。
 * @param invocation - 调用现场（agent / signal）。
 * @returns 结果行；成功时带 append 后的事件 seq。
 */
export async function runHandoff(ctx: HandoffContext, invocation: HandoffInvocation): Promise<HandoffCommandResult> {
  try {
    return await executeHandoff(ctx, invocation);
  } catch (error) {
    // 兜底：surface / 事件读取或 append 之外的意外路径，也不能把异常丢给命令层。
    return { kind: 'error', text: `交接未执行：${reasonOf(error)}。` };
  }
}

/** `runHandoff` 的主体；错误按 §4.5 的文案在各阶段收敛。 */
async function executeHandoff(ctx: HandoffContext, invocation: HandoffInvocation): Promise<HandoffCommandResult> {
  const session = sessionOf(invocation.agent);
  const signal = invocation.signal;

  // ---- 守卫 A/B 与摘要：两个入口共用（handoff.ts）----
  const stage = await prepareHandoff(ctx, session, invocation.agent as HandoffSummarizeAgent, signal);

  switch (stage.kind) {
    case 'busy': {
      return { kind: 'error', text: HANDOFF_TEXTS.busy };
    }
    case 'no-history': {
      // 没有可交接的历史不是失败：与 `/compact` 的 "No compactable history yet." 同构
      // （design.md §4.3 的示例返回值）。
      return { kind: 'success', text: HANDOFF_TEXTS.noHistory };
    }
    case 'cancelled': {
      return { kind: 'error', text: HANDOFF_TEXTS.cancelled };
    }
    case 'summary-failed': {
      return { kind: 'error', text: HANDOFF_TEXTS.summaryFailed };
    }
    case 'ready': {
      break;
    }
  }

  // ---- 守卫 C：摘要期间选区没变（design.md §4.4）----
  if (!sameNodes(session.surface.nodes, stage.surface)) return { kind: 'error', text: HANDOFF_TEXTS.changed };

  if (isAborted(signal)) return { kind: 'error', text: HANDOFF_TEXTS.cancelled };

  // ---- 备份：唯一不可撤销的前置写操作，失败即放弃（design.md §4.3，fail closed）----
  let backupPath: string;
  try {
    backupPath = await writeBackup({ sessionId: session.id, doc: stage.doc, now: stage.now });
  } catch {
    return { kind: 'error', text: HANDOFF_TEXTS.backupFailed };
  }

  // 备份已落盘、append 还没写。这里选择**不 append**：命令层（`dsh-commands`
  // `execute()`）会用同一个 signal 与 handler 赛跑，一旦取消，宿主已经把这次调用
  // 记成 cancelled —— 此时再替换会话，用户看到的是"已取消"而历史已经没了。
  // 备份文件按时间戳命名，留着即可（可读、可重跑），所以如实报告路径。
  if (isAborted(signal)) {
    return { kind: 'error', text: `${HANDOFF_TEXTS.cancelled}（交接单已备份到 ${backupPath}，会话未修改）` };
  }

  // ---- 替换（design.md §4.3）：一条 user/message，surfaceOp.replace 吃掉整个后缀 ----
  try {
    const event = session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `${PREAMBLE}\n\n<handoff>\n${stage.doc}\n</handoff>` }],
      },
      {
        surfaceOp: { op: 'replace', startSeq: stage.range.startSeq, endSeq: stage.range.endSeq },
        // 必须覆盖每一个被遮蔽节点（`Session.append` 会校验完整性）。
        sourceEventSeqs: [...stage.range.seqs],
      },
    );
    return {
      kind: 'success',
      text: `已交接：遮蔽 ${stage.range.seqs.length} 条，备份 ${backupPath}`,
      sourceEventSeq: event.seq,
    };
  } catch (error) {
    // 备份已写、会话没改：告诉用户备份在哪，别让他以为历史已经换掉了。
    return {
      kind: 'error',
      text: `交接单写入会话失败（${reasonOf(error)}），会话未修改；备份见 ${backupPath}`,
    };
  }
}
