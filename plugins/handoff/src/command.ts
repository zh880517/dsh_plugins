// `/handoff` 执行体：守卫 → 摘要 → 备份 → 替换 → 文案（design.md §4.3 / §4.4 / §4.5）。
//
// 只 import 本目录内的相对路径（带 `.js`）与 `node:` 内建：DSH 的包不是本仓库的依赖，
// 真实 Session / Agent / `ctx.llm` 全部用最小结构化接口描述，单测直接传假对象
// （tests/handoff/command.test.ts），不需要伪造整个宿主。
//
// 顺序是刻意的（design.md §4.3）：备份是唯一不可撤销的前置写操作，写不成就绝不
// append（fail closed）；append 之前再确认一次 surface 没变。

import { randomUUID } from 'node:crypto';

import { writeBackup } from './backup.js';
import { inspectBusy, pinnedNodeCount, shadowedRange, type SessionEventView, type SurfaceNode } from './core.js';
import {
  summarizeForHandoff,
  type HandoffLlmMessage,
  type HandoffSummarizeAgent,
  type HandoffSummarizeContext,
} from './summarize.js';

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
 * `session.eventAt(seq)` 的只读视图：`type` 与消息的 `source.kind`。
 *
 * 真实事件形状（`dsh-session` 的 `deriveEventMessage`）：
 * - `user/message`：`data` **就是** message 本身 → `data.source.kind`
 * - `system/message` / `developer/message` / `assistant/message`：message 在 `data.message` 下
 *
 * 这里两层都声明，是为了让"取错层级"在类型和单测里都看得见；`/handoff` 只对
 * `user/message` 读 `data.source.kind`。
 */
export interface HandoffEventView {
  readonly type: string;
  readonly data?:
    | {
        readonly source?: { readonly kind?: string | undefined } | undefined;
        readonly message?: { readonly source?: { readonly kind?: string | undefined } | undefined } | undefined;
      }
    | undefined;
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
export interface HandoffSession {
  /** DSH 会话 id；备份文件名与交接单头部注释都用它。 */
  readonly id: string;
  /** 下一个事件的序号（`Session` 的 `seq` 就是日志长度）。 */
  readonly seq: number;
  /** 有序 surface：节点 seq 数组，模型可见顺序。 */
  readonly surface: { readonly nodes: readonly number[] };
  eventAt(seq: number): HandoffEventView | undefined;
  deriveMessages(): readonly HandoffLlmMessage[];
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

/** design.md §4.5 的固定文案。 */
const TEXT_BUSY = '当前有轮次正在运行或压缩正在进行，交接暂不可用。';
const TEXT_NO_HISTORY = '没有可交接的历史。';
const TEXT_CHANGED = '交接期间会话发生了变化，未执行。请重试。';
const TEXT_SUMMARY_FAILED = '交接单生成失败（模型未返回有效内容），未执行。';
const TEXT_BACKUP_FAILED = '备份写入失败，未执行交接。';
const TEXT_CANCELLED = '交接已取消。';

/** 取消的统一出口（`kind: 'error'`：命令失败但什么都没写）。 */
function cancelled(): HandoffCommandResult {
  return { kind: 'error', text: TEXT_CANCELLED };
}

/** 调用的 Agent 里取出 session；形状不对属于宿主接线错误，交给外层兜底。 */
function sessionOf(agent: unknown): HandoffSession {
  const candidate =
    agent !== null && typeof agent === 'object' ? (agent as { readonly session?: unknown }).session : undefined;
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('调用现场没有关联的会话');
  }
  return candidate as HandoffSession;
}

/**
 * surface 节点的视图（design.md §4.3 / core.ts 的输入）。
 *
 * `session.surface.nodes` 是**数字 seq 数组**，不是节点对象；这里逐个 `eventAt(seq)`
 * 映射成 `SurfaceNode`。映射写错（例如把 `user/message` 的 `source` 取到
 * `data.message.source`）会让工作区指令基线认不出来，`pinnedNodeCount` 变小甚至归 0，
 * 替换区间就会从 surface 节点 0 开始，`Session.append` 的 `assertSystemHeadRewrite`
 * 会抛 "node 0 holds the system prompt"。
 *
 * 因此它是 `export` 的：`tests/handoff/command.test.ts` 直接喂真实形状的事件。
 *
 * `sourceKind` 只对 `user/message` 有意义：`agent-instructions` 基线要靠它识别成
 * "前导注入节点"被保留下来（core.ts 的 `pinnedNodeCount`）。
 */
export function surfaceViews(session: Pick<HandoffSession, 'surface' | 'eventAt'>): SurfaceNode[] {
  const views: SurfaceNode[] = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    // surface 节点一定指向已存在的事件；读不到说明会话视图不自洽，宁可失败也不猜。
    if (event === undefined) throw new Error(`surface 节点 seq ${seq} 没有对应的事件`);
    // 只读 `data.source`：`user/message` 的 data 就是 message（不是 `data.message`）。
    const sourceKind = event.type === 'user/message' ? event.data?.source?.kind : undefined;
    views.push(sourceKind === undefined ? { seq, type: event.type } : { seq, type: event.type, sourceKind });
  }
  return views;
}

/**
 * 整段事件日志的只读视图（design.md §4.4 的忙闲守卫输入）。
 *
 * 包含种子/继承事件：`inspectBusy` 从尾部往前扫，以最新 `session/end-seed` 为界，
 * 只关心其后的未闭合 `turn/start` / `compaction/start`，所以从头扫一遍是安全的。
 */
function eventViews(session: HandoffSession): SessionEventView[] {
  const views: SessionEventView[] = [];
  const end = session.seq;
  for (let seq = 0; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    // 编号连续（`seq = 日志长度`）；真出现空洞就不进视图，宁可少一条也不伪造类型。
    if (event === undefined) continue;
    views.push({ seq, type: event.type });
  }
  return views;
}

/** surface 快照比较：守卫 C 用（design.md §4.4）。 */
function sameNodes(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((seq, index) => seq === right[index]);
}

/** 失败原因收敛成一行，供兜底文案使用。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 取消信号是否已触发。
 *
 * 刻意包一层函数：`signal.aborted` 一旦在某个分支里被 `if (… === true) return` 收窄成
 * `false`，TypeScript 不会因为中间有 `await` 就重置收窄，后续检查会被判成"永假"。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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

  if (isAborted(signal)) return cancelled();

  // ---- 守卫 A：会话空闲（design.md §4.4）----
  //
  // 严格用 inspectBusy 扫整段日志：只要还有未闭合的 `turn/start` 或
  // `compaction/start` 就拒绝。这条**不会**把 `/handoff` 永久锁死，依据是真实
  // 事件顺序（`~/.dsh/sessions` 下 278 份会话日志里 7 次 `/compact` 全部如此）：
  //
  //   seq 4444  turn/end        {"turn":12}
  //   seq 4445  command/run     {"name":"compact","source":{"kind":"user"}}
  //   seq 4446  compaction/start
  //   ...
  //   seq 4449  compaction/end
  //   seq 4450  command/done
  //   seq 4452  turn/start      {"turn":13}   ← 下一轮，属于之后到达的用户消息
  //
  // 也就是说：命令 handler 在**轮次之外**执行，`command/run` / `command/done` 是
  // 日志级事件、不套 turn（`dsh-commands` 的 `execute()` 注释原文："no turn wraps
  // them"）。其它 6 次同样在 `turnDepth === 0` 时进入 `command/run`，紧邻的前一条
  // 事件都是 `turn/end`（一次是 `session/end-seed`）。因此这里不需要"忽略自己所在
  // 的 turn"这种放宽；反过来，用户在轮次运行中发 `/handoff` 会如实得到忙碌文案
  // （design.md §7「不支持在轮次运行中执行」）。
  if (inspectBusy(eventViews(session)) !== 'idle') return { kind: 'error', text: TEXT_BUSY };

  // ---- 守卫 B：有可交接的历史（design.md §4.4）----
  const pinned = pinnedNodeCount(surfaceViews(session));
  const range = shadowedRange(session.surface.nodes, pinned);
  // 没有可交接的历史不是失败：与 `/compact` 的 "No compactable history yet." 同构
  // （design.md §4.3 的示例返回值）。
  if (range === null) return { kind: 'success', text: TEXT_NO_HISTORY };

  // ---- 摘要（design.md §4.2）：回放前缀 = 整段当前可见历史，指令由 summarize 追加 ----
  const surfaceBefore = [...session.surface.nodes];
  const messages = session.deriveMessages();

  let text: string;
  try {
    const summary = await summarizeForHandoff(ctx, { messages }, invocation.agent as HandoffSummarizeAgent, signal);
    text = summary.text;
  } catch {
    // summarize 已 fail closed（空文本 / error|aborted|max-tokens|tool-calls 都抛错）。
    if (isAborted(signal)) return cancelled();
    return { kind: 'error', text: TEXT_SUMMARY_FAILED };
  }

  // ---- 交接单文档（design.md §6）：头部注释 + 正文；备份与替换用同一个字符串 ----
  const now = new Date();
  const doc =
    `<!-- handoff: ${randomUUID()} at ${now.toISOString()} from session ${session.id} ` +
    `(seq ${range.startSeq}..${range.endSeq}) -->\n\n${text}`;

  // ---- 守卫 C：摘要期间选区没变（design.md §4.4）----
  if (!sameNodes(session.surface.nodes, surfaceBefore)) return { kind: 'error', text: TEXT_CHANGED };

  if (isAborted(signal)) return cancelled();

  // ---- 备份：唯一不可撤销的前置写操作，失败即放弃（design.md §4.3，fail closed）----
  let backupPath: string;
  try {
    backupPath = await writeBackup({ sessionId: session.id, doc, now });
  } catch {
    return { kind: 'error', text: TEXT_BACKUP_FAILED };
  }

  // 备份已落盘、append 还没写。这里选择**不 append**：命令层（`dsh-commands`
  // `execute()`）会用同一个 signal 与 handler 赛跑，一旦取消，宿主已经把这次调用
  // 记成 cancelled —— 此时再替换会话，用户看到的是"已取消"而历史已经没了。
  // 备份文件按时间戳命名，留着即可（可读、可重跑），所以如实报告路径。
  if (isAborted(signal)) {
    return { kind: 'error', text: `${TEXT_CANCELLED}（交接单已备份到 ${backupPath}，会话未修改）` };
  }

  // ---- 替换（design.md §4.3）：一条 user/message，surfaceOp.replace 吃掉整个后缀 ----
  try {
    const event = session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `${PREAMBLE}\n\n<handoff>\n${doc}\n</handoff>` }],
      },
      {
        surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
        // 必须覆盖每一个被遮蔽节点（`Session.append` 会校验完整性）。
        sourceEventSeqs: [...range.seqs],
      },
    );
    return {
      kind: 'success',
      text: `已交接：遮蔽 ${range.seqs.length} 条，备份 ${backupPath}`,
      sourceEventSeq: event.seq,
    };
  } catch (error) {
    // 备份已写、会话没改：告诉用户备份在哪，别让他以为历史已经换掉了。
    return { kind: 'error', text: `交接单写入会话失败（${reasonOf(error)}），会话未修改；备份见 ${backupPath}` };
  }
}
