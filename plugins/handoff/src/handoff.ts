// 两个入口共用的一段核心：快照 → 守卫（忙 / 有历史）→ 摘要 → 交接单（design.md §2「一套核心」）。
//
// 就地交接（command.ts）与新会话草稿（draft.ts）在这段之后才分岔：前者备份 + replace，
// 后者只把文本交给新会话。守卫、文案（§4.5）与交接单头部注释（§6）收在这里，两条入口
// 就不会各自漂移——尤其是"忙 / 无历史 / 摘要失败"这三种必须逐字一致的文案。
//
// 只 import 本目录内的相对路径（带 `.js`）与 `node:` 内建：DSH 的包不是本仓库的依赖，
// 真实 Session / Agent 用最小结构化接口描述，单测直接传假对象
// （tests/handoff/command.test.ts 与 draft.test.ts），不需要伪造整个宿主。

import { randomUUID } from 'node:crypto';

import {
  inspectBusy,
  pinnedNodeCount,
  shadowedRange,
  type SessionEventView,
  type ShadowedRange,
  type SurfaceNode,
} from './core.js';
import {
  summarizeForHandoff,
  type HandoffLlmMessage,
  type HandoffSummarizeAgent,
  type HandoffSummarizeContext,
} from './summarize.js';

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
 * 守卫与摘要只需要读的 Session 视图。
 *
 * `draft.ts` 用的就是这个类型：它**没有** `append`，所以"预览不写会话"由类型保证，
 * 不是靠调用方自觉。`/handoff` 的 `HandoffSession` 在它之上补 `append`。
 */
export interface HandoffSessionView {
  /** DSH 会话 id；交接单头部注释用它，`/handoff` 的备份文件名也用它。 */
  readonly id: string;
  /** 下一个事件的序号（`Session` 的 `seq` 就是日志长度）。 */
  readonly seq: number;
  /** 有序 surface：节点 seq 数组，模型可见顺序。 */
  readonly surface: { readonly nodes: readonly number[] };
  eventAt(seq: number): HandoffEventView | undefined;
  deriveMessages(): readonly HandoffLlmMessage[];
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
export function surfaceViews(session: Pick<HandoffSessionView, 'surface' | 'eventAt'>): SurfaceNode[] {
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
export function eventViews(session: Pick<HandoffSessionView, 'seq' | 'eventAt'>): SessionEventView[] {
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

/**
 * 取消信号是否已触发。
 *
 * 刻意包一层函数：`signal.aborted` 一旦在某个分支里被 `if (… === true) return` 收窄成
 * `false`，TypeScript 不会因为中间有 `await` 就重置收窄，后续检查会被判成"永假"。
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** 失败原因收敛成一行，供兜底文案使用。 */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * design.md §4.5 的固定文案。
 *
 * 两个入口共用：draft 只用到 `busy` / `noHistory` / `summaryFailed` / `cancelled`；
 * `changed` 与 `backupFailed` 是 `/handoff` 独有的阶段（draft 不做选区稳定检查、不写备份）。
 */
export const HANDOFF_TEXTS = {
  busy: '当前有轮次正在运行或压缩正在进行，交接暂不可用。',
  noHistory: '没有可交接的历史。',
  changed: '交接期间会话发生了变化，未执行。请重试。',
  summaryFailed: '交接单生成失败（模型未返回有效内容），未执行。',
  backupFailed: '备份写入失败，未执行交接。',
  cancelled: '交接已取消。',
} as const;

/**
 * 交接单文档（design.md §6）：头部注释 + 摘要正文。
 *
 * 备份文件、替换消息的 `<handoff>` 段与 draft 响应里的 `doc` 共用这一个拼法，
 * 三处不会出现"头部格式略有不同"。头部时间与备份文件名用同一个 `now`。
 *
 * @param input.sessionId - 源会话 id。
 * @param input.range - 被遮蔽区间（只取两端 seq 写进头部）。
 * @param input.text - 摘要正文。
 * @param input.now - 头部时间；`/handoff` 同时用它命名备份文件。
 * @returns 完整交接单（含头部注释）。
 */
export function buildHandoffDoc(input: {
  readonly sessionId: string;
  readonly range: Pick<ShadowedRange, 'startSeq' | 'endSeq'>;
  readonly text: string;
  readonly now: Date;
}): string {
  return (
    `<!-- handoff: ${randomUUID()} at ${input.now.toISOString()} from session ${input.sessionId} ` +
    `(seq ${input.range.startSeq}..${input.range.endSeq}) -->\n\n${input.text}`
  );
}

/**
 * 共用阶段的结果：拿到 `ready` 之前，两个入口都还没写过任何东西。
 *
 * `surface` 是摘要**前**的 surface 快照：`/handoff` 用它做守卫 C（摘要期间选区变了就
 * 放弃替换）；draft 刻意忽略它（理由写在 draft.ts）。
 */
export type HandoffStage =
  | { readonly kind: 'busy' }
  | { readonly kind: 'no-history' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'summary-failed' }
  | {
      readonly kind: 'ready';
      /** 完整交接单（含 §6 的头部注释）。 */
      readonly doc: string;
      /** 被遮蔽的节点数；`no-history` 不会走到这里。 */
      readonly shadowable: number;
      /** 被遮蔽区间：`/handoff` 的备份与 replace 都要用。 */
      readonly range: ShadowedRange;
      /** 头部时间与备份文件名共用的时间戳。 */
      readonly now: Date;
      /** 摘要前的 `session.surface.nodes` 快照。 */
      readonly surface: readonly number[];
    };

/**
 * 守卫 + 摘要：两个入口共用的一段（design.md §2）。
 *
 * 顺序与 `/handoff` 一致：取消 → 忙 → 有历史 → 摘要。**不**在这里做"选区稳定"检查：
 * 那是 `/handoff` 替换前的要求（拿到 doc 之后 surface 又变了，replace 区间就可能遮蔽错
 * 东西）；draft 不需要它，理由写在 draft.ts 里。所以这里只把快照交出去，由调用方决定。
 *
 * 失败原因都收敛成 stage 的 `kind`，不抛异常；只有 surface / 事件读取自相矛盾这类宿主
 * 接线错误会逃出去，由调用方兜底（`/handoff` 折成 `交接未执行：<原因>。`）。
 *
 * @param ctx - 宿主上下文（只需 `llm.stream`）。
 * @param session - 只读会话视图。
 * @param agent - 提供目标模型、session id 与 tool history 的真实 Agent。
 * @param signal - 可选取消信号。
 * @returns 阶段结果；`ready` 才表示拿到了交接单。
 */
export async function prepareHandoff(
  ctx: HandoffSummarizeContext,
  session: HandoffSessionView,
  agent: HandoffSummarizeAgent,
  signal?: AbortSignal,
): Promise<HandoffStage> {
  if (isAborted(signal)) return { kind: 'cancelled' };

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
  // （design.md §7「不支持在轮次运行中执行」）。draft 走 HTTP，同样在轮次之外调用。
  if (inspectBusy(eventViews(session)) !== 'idle') return { kind: 'busy' };

  // ---- 守卫 B：有可交接的历史（design.md §4.4）----
  const pinned = pinnedNodeCount(surfaceViews(session));
  const range = shadowedRange(session.surface.nodes, pinned);
  // 没有可交接的历史不是失败：两个入口各自把它映射成自己的成功形态
  // （`/handoff` 返回文案，draft 返回 `shadowable: 0` 的空草稿）。
  if (range === null) return { kind: 'no-history' };

  // ---- 摘要（design.md §4.2）：回放前缀 = 整段当前可见历史，指令由 summarize 追加 ----
  const surface = [...session.surface.nodes];
  const messages = session.deriveMessages();

  let text: string;
  try {
    text = (await summarizeForHandoff(ctx, { messages }, agent, signal)).text;
  } catch {
    // summarize 已 fail closed（空文本 / error|aborted|max-tokens|tool-calls 都抛错）。
    if (isAborted(signal)) return { kind: 'cancelled' };
    return { kind: 'summary-failed' };
  }

  // ---- 交接单文档（design.md §6）：头部注释 + 正文；备份与替换用同一个字符串 ----
  const now = new Date();
  return {
    kind: 'ready',
    doc: buildHandoffDoc({ sessionId: session.id, range, text, now }),
    shadowable: range.seqs.length,
    range,
    now,
    surface,
  };
}
