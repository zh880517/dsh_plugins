// 纯逻辑：交接范围（保留哪段、遮蔽哪段）与入口守卫（能不能交接）。
//
// 这里刻意 **不** import `@deepseek-ai/dsh-session`：DSH 的包不是本仓库的依赖，
// 插件的 Host 半只允许 node: 内建与自身目录内的相对路径。真实 Session 的
// `surface.nodes`（seq 数组）与事件日志（seq + type）都能用「朴素只读数组」
// 表达，因此这些判断全部写成纯函数，单测不需要构造真实 Session。
//
// 设计文档：docs/plugins/handoff/design.md §4.3 / §4.4 / §9 V1。

/** Surface 上的一个节点的只读视图：seq 是事件序号，type 是产生该节点的事件类型。 */
export interface SurfaceNode {
  readonly seq: number;
  /** 事件类型，如 `system/message` / `user/message` / `developer/message` / `assistant/message`。 */
  readonly type: string;
  /** `user/message` 的 `data.source.kind`，如 `user` / `agent-instructions`；其它事件为 undefined。 */
  readonly sourceKind?: string | undefined;
}

/** 事件日志里的一个只读条目：只需要 seq 与 type 就能判断忙闲。 */
export interface SessionEventView {
  readonly seq: number;
  readonly type: string;
}

/** 被遮蔽的 surface 后缀（含区间两端的 seq 与完整 seq 列表）。 */
export interface ShadowedRange {
  /** 区间第一个（最旧）节点的 seq，即 `surfaceOp.replace.startSeq`。 */
  readonly startSeq: number;
  /** 区间最后一个（最新）节点的 seq，即 `surfaceOp.replace.endSeq`。 */
  readonly endSeq: number;
  /** 区间内全部节点 seq，按 surface 顺序；append 时必须逐条写进 `sourceEventSeqs`。 */
  readonly seqs: number[];
}

/** `inspectBusy` 的三种结论。 */
export type BusyReason = 'idle' | 'open-turn' | 'open-compaction';

/**
 * 前导注入节点（会被保留下来的那些）：工作区指令基线、developer 消息、追加的 system 消息。
 *
 * `dsh-agent-instructions` 注入的基线是一条 `user/message`，`source.kind` 为
 * `agent-instructions`（见该插件源码）。DSH 目前没有在 replace 后自动重注工作区指令的
 * 保证（design.md §9 V1 待真机验证），所以 P1 保守地把它们留在前面。
 */
function isLeadingInjection(node: SurfaceNode): boolean {
  if (node.type === 'system/message' || node.type === 'developer/message') return true;
  return node.type === 'user/message' && node.sourceKind === 'agent-instructions';
}

/**
 * 计算要保留的**前导节点数**：至少保住 system 头（surface 头确实是 `system/message` 时
 * 保留 1 个），再把紧跟其后的前导注入节点一起留下。
 *
 * 只跳过**开头连续**的注入节点：中途出现的注入（例如后续的指令更新）仍属于会话后缀，
 * 会被交接遮蔽。
 *
 * @param nodes - `session.surface.nodes` 对应的节点视图，按 surface 顺序。
 * @returns 前导保留数量，范围 `0..nodes.length`；空 surface 返回 0。
 */
export function pinnedNodeCount(nodes: readonly SurfaceNode[]): number {
  const head = nodes[0];
  if (head === undefined) return 0;
  // 常规会话的节点 0 是 system 提示词：它永远不进遮蔽区间。
  let pinned = head.type === 'system/message' ? 1 : 0;
  while (pinned < nodes.length) {
    const node = nodes[pinned];
    if (node === undefined || !isLeadingInjection(node)) break;
    pinned += 1;
  }
  return pinned;
}

/**
 * 从 `surface.nodes` 算出被遮蔽的**后缀**：保留前 `pinnedCount` 个节点，其余全部遮蔽。
 *
 * 后缀性质保证所有 tool call / result 对都完整落在区间内，不会切断配对（design.md §4.3）。
 *
 * @param nodes - `session.surface.nodes`（seq 数组），按 surface 顺序。
 * @param pinnedCount - `pinnedNodeCount` 的结果；越界会被收敛到 `0..nodes.length`。
 * @returns 遮蔽区间；没有可遮蔽历史时返回 `null`。
 */
export function shadowedRange(nodes: readonly number[], pinnedCount: number): ShadowedRange | null {
  const requested = Number.isSafeInteger(pinnedCount) && pinnedCount > 0 ? pinnedCount : 0;
  const pinned = Math.min(requested, nodes.length);
  const seqs = nodes.slice(pinned);
  const startSeq = seqs[0];
  const endSeq = seqs[seqs.length - 1];
  if (startSeq === undefined || endSeq === undefined) return null;
  return { startSeq, endSeq, seqs };
}

/**
 * 最新一条 `session/end-seed` 在事件视图里的下标；没有就返回 `-1`。
 *
 * fork 出来的会话以 `session/end-seed` 收尾：`dsh-session` 的 `buildForkSeed`
 * 只闭合 turn（补 `turn/end`），**不闭合** `compaction/start`。压缩后端自己承认这个
 * 例外：未配对的 `compaction/start` 如果早于最新的 `session/end-seed`，就不算活跃
 * （`dsh-compaction-basic` 的 `assertCompactionInactive`）。所以这里也只能看
 * "最新 seed 之后"的事件。
 */
function latestEndSeedIndex(events: readonly SessionEventView[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'session/end-seed') return index;
  }
  return -1;
}

/**
 * 判断会话当前能否交接：只看**最新 `session/end-seed` 之后**的事件，从末尾往旧扫，
 * 遇到未闭合的标记就停。
 *
 * - `turn/start` 没有配对的 `turn/end` → 有轮次在跑：`open-turn`
 * - `compaction/start` 没有配对的 `compaction/end` → 压缩正在进行：`open-compaction`
 * - 两者都已闭合（或从未出现）→ `idle`
 *
 * seed 之前的事件属于上一段会话生命周期（fork 时被冻结的父会话）：`buildForkSeed`
 * 不闭合 compaction，若把它们算进来，从"压缩进行中"的会话 fork 出来的新会话会永久
 * 返回 `open-compaction`、永远无法交接。
 *
 * 两个标记都未闭合时，返回**离末尾最近**的那一个，因为它是当前正在发生的事。
 * 两种忙碌在结果文案上不区分（都提示"轮次运行或压缩进行中"）。
 *
 * @param events - 整段事件日志的只读视图，必须按 seq 升序（允许包含种子/继承事件）。
 * @returns 忙碌原因；`idle` 表示可以进入摘要流程。
 */
export function inspectBusy(events: readonly SessionEventView[]): BusyReason {
  let turnSettled = false;
  let compactionSettled = false;
  const boundary = latestEndSeedIndex(events);
  for (let index = events.length - 1; index > boundary; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (!turnSettled) {
      if (event.type === 'turn/start') return 'open-turn';
      if (event.type === 'turn/end') turnSettled = true;
    }
    if (!compactionSettled) {
      if (event.type === 'compaction/start') return 'open-compaction';
      if (event.type === 'compaction/end') compactionSettled = true;
    }
    if (turnSettled && compactionSettled) break;
  }
  return 'idle';
}
