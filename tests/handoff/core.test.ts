// T2 纯逻辑：交接范围（保留哪段 / 遮蔽哪段）与入口守卫（busy 三态）。
// 设计文档：docs/plugins/handoff/design.md §4.3 / §4.4 / §9 V1
import { describe, expect, it } from 'vitest';
import {
  inspectBusy,
  pinnedNodeCount,
  shadowedRange,
  type SessionEventView,
  type SurfaceNode,
} from '../../plugins/handoff/src/core.js';

// ---- fixtures ----

function system(seq: number): SurfaceNode {
  return { seq, type: 'system/message' };
}

function user(seq: number): SurfaceNode {
  return { seq, type: 'user/message', sourceKind: 'user' };
}

function instructions(seq: number): SurfaceNode {
  return { seq, type: 'user/message', sourceKind: 'agent-instructions' };
}

function developer(seq: number): SurfaceNode {
  return { seq, type: 'developer/message' };
}

function assistant(seq: number): SurfaceNode {
  return { seq, type: 'assistant/message' };
}

function log(...types: string[]): SessionEventView[] {
  return types.map((type, seq) => ({ seq, type }));
}

describe('pinnedNodeCount：保留的前导节点', () => {
  it('空 surface 不保留任何节点', () => {
    expect(pinnedNodeCount([])).toBe(0);
  });

  it('保留 system 头（至少 1 个）', () => {
    expect(pinnedNodeCount([system(0), user(1), assistant(2)])).toBe(1);
    expect(pinnedNodeCount([system(0)])).toBe(1);
  });

  it('继续跳过紧跟 system 的前导注入节点', () => {
    // 工作区指令基线（user/message + agent-instructions）与 developer 消息都不进遮蔽区间
    const nodes = [system(0), instructions(1), developer(2), user(3), assistant(4)];
    expect(pinnedNodeCount(nodes)).toBe(3);
  });

  it('多个前导注入节点连续出现时全部保留', () => {
    expect(pinnedNodeCount([system(0), instructions(1), instructions(2), user(3)])).toBe(3);
    expect(pinnedNodeCount([system(0), system(1), developer(2), user(3)])).toBe(3);
  });

  it('中途出现的注入节点不跳过（它属于要被交接的后缀）', () => {
    expect(pinnedNodeCount([system(0), user(1), instructions(2)])).toBe(1);
    expect(pinnedNodeCount([system(0), user(1), developer(2), user(3)])).toBe(1);
  });

  it('surface 头不是 system 时不硬留节点', () => {
    expect(pinnedNodeCount([user(0), assistant(1)])).toBe(0);
  });

  it('只有前导注入节点时全部保留', () => {
    expect(pinnedNodeCount([system(0), instructions(1)])).toBe(2);
  });
});

describe('shadowedRange：被遮蔽的后缀', () => {
  it('保留前缀，遮蔽其余后缀（含完整 seq 列表）', () => {
    expect(shadowedRange([3, 5, 7, 9], 1)).toEqual({ startSeq: 5, endSeq: 9, seqs: [5, 7, 9] });
    expect(shadowedRange([3, 5, 7, 9], 2)).toEqual({ startSeq: 7, endSeq: 9, seqs: [7, 9] });
  });

  it('没有可遮蔽历史时返回 null', () => {
    expect(shadowedRange([3], 1)).toBeNull();
    expect(shadowedRange([3], 5)).toBeNull();
    expect(shadowedRange([], 0)).toBeNull();
  });

  it('pinnedCount 越界或非法时收敛到 0..nodes.length', () => {
    expect(shadowedRange([3, 5], 9)).toBeNull();
    expect(shadowedRange([3, 5], -2)).toEqual({ startSeq: 3, endSeq: 5, seqs: [3, 5] });
    expect(shadowedRange([3, 5], 1.5)).toEqual({ startSeq: 3, endSeq: 5, seqs: [3, 5] });
    expect(shadowedRange([3, 5], Number.NaN)).toEqual({ startSeq: 3, endSeq: 5, seqs: [3, 5] });
  });

  it('与 pinnedNodeCount 组合：system + 工作区指令留下，其余遮蔽', () => {
    const nodes = [system(2), instructions(4), user(6), assistant(8), user(10)];
    const pinned = pinnedNodeCount(nodes);
    const range = shadowedRange(
      nodes.map((node) => node.seq),
      pinned,
    );
    expect(pinned).toBe(2);
    expect(range).toEqual({ startSeq: 6, endSeq: 10, seqs: [6, 8, 10] });
  });
});

describe('inspectBusy：交接入口的忙闲判断', () => {
  it('idle：空日志、无关事件、已配对的轮次', () => {
    expect(inspectBusy([])).toBe('idle');
    expect(inspectBusy(log('session/start', 'request/header', 'user/message'))).toBe('idle');
    expect(inspectBusy(log('turn/start', 'user/message', 'assistant/message', 'turn/end'))).toBe('idle');
  });

  it('open-turn：turn/start 没有配对的 turn/end', () => {
    expect(inspectBusy(log('turn/start'))).toBe('open-turn');
    expect(inspectBusy(log('turn/start', 'turn/end', 'turn/start', 'assistant/message'))).toBe('open-turn');
  });

  it('open-compaction：未匹配的 compaction/start', () => {
    expect(inspectBusy(log('compaction/start'))).toBe('open-compaction');
    expect(inspectBusy(log('turn/start', 'turn/end', 'compaction/start', 'compaction/summary'))).toBe('open-compaction');
  });

  it('idle：压缩已闭合', () => {
    expect(
      inspectBusy(log('turn/start', 'compaction/start', 'compaction/summary', 'compaction/end', 'turn/end')),
    ).toBe('idle');
  });

  it('两种标记都未闭合时，返回离末尾最近的那个', () => {
    expect(inspectBusy(log('compaction/start', 'turn/start'))).toBe('open-turn');
    expect(inspectBusy(log('turn/start', 'compaction/start'))).toBe('open-compaction');
  });
});

describe('inspectBusy：只看最新 session/end-seed 之后的事件', () => {
  // `buildForkSeed` 只闭合 turn，不闭合 compaction；压缩后端也承认
  // "未配对的 compaction/start 早于最新 session/end-seed 就不算活跃"
  // （dsh-compaction-basic 的 assertCompactionInactive）。不按这条边界截断，
  // 从"压缩进行中"的会话 fork 出来的新会话会永久 busy。

  it('idle：compaction/start 早于 seed，之后没有未闭合事件', () => {
    expect(inspectBusy(log('compaction/start', 'session/end-seed'))).toBe('idle');
    expect(inspectBusy(log('compaction/start', 'compaction/summary', 'session/end-seed'))).toBe('idle');
  });

  it('open-compaction：compaction/start 晚于 seed', () => {
    expect(inspectBusy(log('session/end-seed', 'compaction/start'))).toBe('open-compaction');
    expect(inspectBusy(log('compaction/start', 'session/end-seed', 'compaction/start'))).toBe('open-compaction');
  });

  it('idle：turn/start 早于 seed（turn 的对称场景）', () => {
    expect(inspectBusy(log('turn/start', 'session/end-seed'))).toBe('idle');
    expect(inspectBusy(log('turn/start', 'compaction/start', 'session/end-seed'))).toBe('idle');
  });

  it('open-turn：turn/start 晚于 seed', () => {
    expect(inspectBusy(log('session/end-seed', 'turn/start'))).toBe('open-turn');
    expect(
      inspectBusy(log('session/end-seed', 'compaction/start', 'compaction/end', 'turn/start')),
    ).toBe('open-turn');
  });

  it('只看最新 seed：多个 seed 时以最后一个为边界', () => {
    // 旧 seed 之后的 compaction/start 被新 seed 截断
    expect(
      inspectBusy(log('compaction/start', 'session/end-seed', 'compaction/start', 'session/end-seed')),
    ).toBe('idle');
    // 最新 seed 之后的新 compaction/start 仍然算忙碌
    expect(
      inspectBusy(log('session/end-seed', 'compaction/start', 'session/end-seed', 'compaction/start')),
    ).toBe('open-compaction');
  });
});
