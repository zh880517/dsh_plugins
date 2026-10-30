// T4 命令：守卫 → 摘要 → 备份 → 替换 → 文案（design.md §4.3 / §4.4 / §4.5）。
//
// 全部用假 session（自己造对象，不连真 DSH），备份落到 os.tmpdir() 里的临时目录：
// 断言的是「append 的形状」「备份文件与 <handoff> 段逐字一致」「失败时一条都没写」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PREAMBLE,
  runHandoff,
  surfaceViews,
  type HandoffAppendOptions,
  type HandoffCommandResult,
  type HandoffEventView,
  type HandoffInvocation,
  type HandoffSession,
  type HandoffUserMessage,
} from '../../plugins/handoff/src/command.js';
import { pinnedNodeCount, shadowedRange } from '../../plugins/handoff/src/core.js';
import {
  HANDOFF_INSTRUCTION,
  type HandoffLlmMessage,
  type HandoffStreamChunk,
  type HandoffStreamOptions,
} from '../../plugins/handoff/src/summarize.js';

// 备份模块包一层：只为了在「备份已写、append 未写」这个瞬间注入取消。
// 其余行为一律透传真实实现，所以对这个文件里的其它用例没有影响。
const backupHook = vi.hoisted(() => ({ afterWrite: undefined as (() => void) | undefined }));

vi.mock('../../plugins/handoff/src/backup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plugins/handoff/src/backup.js')>();
  return {
    ...actual,
    writeBackup: async (request: Parameters<typeof actual.writeBackup>[0]): Promise<string> => {
      const file = await actual.writeBackup(request);
      backupHook.afterWrite?.();
      return file;
    },
  };
});

// ---- fixtures ----

const BUSY_TEXT = '当前有轮次正在运行或压缩正在进行，交接暂不可用。';
const NO_HISTORY_TEXT = '没有可交接的历史。';
const CHANGED_TEXT = '交接期间会话发生了变化，未执行。请重试。';
const SUMMARY_FAILED_TEXT = '交接单生成失败（模型未返回有效内容），未执行。';
const BACKUP_FAILED_TEXT = '备份写入失败，未执行交接。';
const CANCELLED_TEXT = '交接已取消。';

const SUMMARY_TEXT = '# 交接：T4\n\n## 目标\n把 `command.ts` 接上。\n\n## 下一步\n跑 `npx vitest run tests/handoff`。';

/** 一个事件：surface 节点还要带 `source.kind`。 */
interface FakeEvent {
  readonly seq: number;
  readonly type: string;
  readonly sourceKind?: string | undefined;
}

interface AppendCall {
  readonly type: string;
  readonly data: HandoffUserMessage;
  readonly opts: HandoffAppendOptions;
}

interface FakeSessionHandle {
  readonly session: FakeSessionLike;
  readonly appends: AppendCall[];
  readonly deriveCount: () => number;
  /** 摘要期间偷偷换掉 surface（守卫 C 用）。 */
  setSurface(nodes: readonly number[]): void;
  /** 摘要期间追加一个事件（守卫 C 用）。 */
  addEvent(event: FakeEvent): void;
}

/** 假 Session：只实现 command.ts 用到的那几处，语义与真实 SurfaceManager 对齐。 */
interface FakeSessionLike {
  readonly id: string;
  readonly seq: number;
  readonly surface: { readonly nodes: readonly number[] };
  eventAt(seq: number): HandoffEventView | undefined;
  deriveMessages(): readonly HandoffLlmMessage[];
  append(type: 'user/message', data: HandoffUserMessage, opts: HandoffAppendOptions): { readonly seq: number };
  requestHeader(): { readonly config: { readonly provider: string; readonly model: string } };
  toolHistory(): unknown;
}

function fakeSession(options: {
  readonly events: readonly FakeEvent[];
  readonly surface: readonly number[];
  readonly id?: string;
}): FakeSessionHandle {
  const events: FakeEvent[] = options.events.map((event) => ({ ...event }));
  let surface: number[] = [...options.surface];
  const appends: AppendCall[] = [];
  let deriveCount = 0;

  /** 事件日志的下一个 seq：真实 Session 的 `seq` 就是日志长度。 */
  const nextSeq = (): number => (events.length === 0 ? 0 : Math.max(...events.map((event) => event.seq)) + 1);

  const session: FakeSessionLike = {
    id: options.id ?? 'session-test',
    get seq(): number {
      return nextSeq();
    },
    get surface(): { readonly nodes: readonly number[] } {
      return { nodes: surface };
    },
    eventAt(seq: number): HandoffEventView | undefined {
      const event = events.find((candidate) => candidate.seq === seq);
      if (event === undefined) return undefined;
      // 与真实事件一致：`user/message` 的 source.kind 在 data.source 里
      return event.sourceKind === undefined
        ? { type: event.type }
        : { type: event.type, data: { source: { kind: event.sourceKind } } };
    },
    deriveMessages(): readonly HandoffLlmMessage[] {
      deriveCount += 1;
      return surface.map((seq) => ({ role: 'user', content: [{ type: 'text', text: `node-${seq}` }] }));
    },
    append(type: 'user/message', data: HandoffUserMessage, opts: HandoffAppendOptions): { readonly seq: number } {
      const seq = nextSeq();
      events.push({ seq, type });
      appends.push({ type, data, opts });
      // 与 SurfaceManager.applySurfacePlan 一致：replace 把区间换成新节点。
      const start = surface.indexOf(opts.surfaceOp.startSeq);
      const end = surface.indexOf(opts.surfaceOp.endSeq);
      surface =
        start === -1 || end === -1
          ? [...surface, seq]
          : [...surface.slice(0, start), seq, ...surface.slice(end + 1)];
      return { seq };
    },
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
    toolHistory: () => ({ tools: [] }),
  };

  return {
    session,
    appends,
    deriveCount: () => deriveCount,
    setSurface(nodes: readonly number[]): void {
      surface = [...nodes];
    },
    addEvent(event: FakeEvent): void {
      events.push({ ...event });
    },
  };
}

/** 一个「system + 工作区指令 + 两轮问答」的会话：pinned = 2，遮蔽 [2,3,4,5]。 */
const BASE_EVENTS: readonly FakeEvent[] = [
  { seq: 0, type: 'system/message' },
  { seq: 1, type: 'user/message', sourceKind: 'agent-instructions' },
  { seq: 2, type: 'user/message', sourceKind: 'user' },
  { seq: 3, type: 'assistant/message' },
  { seq: 4, type: 'user/message', sourceKind: 'user' },
  { seq: 5, type: 'assistant/message' },
];
const BASE_SURFACE = [0, 1, 2, 3, 4, 5];

interface FakeLlm {
  readonly calls: HandoffStreamOptions[];
  readonly ctx: { readonly llm: { stream(options: HandoffStreamOptions): AsyncIterable<HandoffStreamChunk> } };
}

function fakeLlm(
  chunks:
    | readonly HandoffStreamChunk[]
    | ((options: HandoffStreamOptions) => readonly HandoffStreamChunk[]),
): FakeLlm {
  const calls: HandoffStreamOptions[] = [];
  return {
    calls,
    ctx: {
      llm: {
        stream(options: HandoffStreamOptions): AsyncIterable<HandoffStreamChunk> {
          calls.push(options);
          const produced = typeof chunks === 'function' ? chunks(options) : chunks;
          return (async function* generate(): AsyncGenerator<HandoffStreamChunk> {
            for (const chunk of produced) yield chunk;
          })();
        },
      },
    },
  };
}

/** 缺省的摘要输出：一段正常文本 + stop。 */
const OK_CHUNKS: readonly HandoffStreamChunk[] = [
  { type: 'text-delta', index: 0, text: SUMMARY_TEXT },
  { type: 'finish', reason: { kind: 'stop' } },
];

function invocationOf(agent: unknown, signal?: AbortSignal): HandoffInvocation {
  return {
    commandId: 'cmd-test-1',
    agent,
    rawInput: '',
    signal: signal ?? new AbortController().signal,
  };
}

/** 从替换消息的正文里取出 `<handoff>` 段（应当与备份文件逐字一致）。 */
function handoffDocOf(message: HandoffUserMessage): string {
  const block = message.content[0];
  expect(block).toBeDefined();
  const text = block?.text ?? '';
  expect(text.startsWith(PREAMBLE)).toBe(true);
  const open = '<handoff>\n';
  const close = '\n</handoff>';
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + open.length, end);
}

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-command-'));
  home = path.join(tmp, 'handoff');
  process.env['HANDOFF_HOME'] = home;
});

afterEach(() => {
  delete process.env['HANDOFF_HOME'];
  backupHook.afterWrite = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 备份目录里现有的文件名（目录不存在就是空）。 */
function backupFiles(): string[] {
  return fs.existsSync(home) ? fs.readdirSync(home) : [];
}

function expectNoWrites(handle: FakeSessionHandle): void {
  expect(handle.appends).toEqual([]);
  expect(backupFiles()).toEqual([]);
}

// ---- tests ----

describe('runHandoff：成功路径', () => {
  it('append 一次 user/message + surfaceOp.replace，返回遮蔽条数与备份路径', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result.kind).toBe('success');
    expect(result.text).toContain('已交接：遮蔽 4 条');
    expect(result.text).toContain('备份 ');
    // sourceEventSeq 是 append 之后的事件 seq（基线 0..5 → 6）
    expect(result.sourceEventSeq).toBe(6);

    // ---- 摘要用的回放前缀就是 deriveMessages()，指令由 summarize 追加 ----
    expect(handle.deriveCount()).toBe(1);
    const options = llm.calls[0];
    expect(options).toBeDefined();
    expect(options?.messages).toHaveLength(BASE_SURFACE.length + 1);
    expect(options?.messages.slice(0, BASE_SURFACE.length)).toEqual(
      BASE_SURFACE.map((seq) => ({ role: 'user', content: [{ type: 'text', text: `node-${seq}` }] })),
    );
    expect(options?.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: HANDOFF_INSTRUCTION }],
    });

    // ---- append 的形状 ----
    expect(handle.appends).toHaveLength(1);
    const call = handle.appends[0];
    expect(call?.type).toBe('user/message');
    expect(call?.data.role).toBe('user');
    expect(call?.data.source).toEqual({ kind: 'user' });
    // 真实 Session 恢复会话时要求 message 带稳定 id（缺了下一次加载会失败）
    expect(typeof call?.data.id).toBe('string');
    expect(call?.data.id.length).toBeGreaterThan(0);
    expect(call?.data.content).toHaveLength(1);

    // 被遮蔽的是 surface 后缀的头尾，且 sourceEventSeqs 覆盖每一个被遮蔽节点
    expect(call?.opts.surfaceOp).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 });
    expect(call?.opts.sourceEventSeqs).toEqual([2, 3, 4, 5]);

    // 替换后 surface 只剩 system + 工作区指令 + 交接单
    expect(handle.session.surface.nodes).toEqual([0, 1, 6]);
  });

  it('交接单头部注释符合 §6，备份与 <handoff> 段逐字一致', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE, id: 'session-abc' });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));
    expect(result.kind).toBe('success');

    const message = handle.appends[0]?.data;
    expect(message).toBeDefined();
    const doc = handoffDocOf(message as HandoffUserMessage);

    expect(doc.startsWith('<!-- handoff: ')).toBe(true);
    expect(doc).toMatch(
      /^<!-- handoff: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z from session session-abc \(seq 2\.\.5\) -->\n\n# 交接：T4/,
    );
    expect(doc.endsWith(SUMMARY_TEXT)).toBe(true);

    // 备份真的写到了 HANDOFF_HOME 下，文件名是 <sessionId>-<yyyyMMdd-HHmmss>.md
    const files = backupFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^session-abc-\d{8}-\d{6}\.md$/);
    const backupPath = path.join(home, files[0] as string);
    // 返回文案里的路径就是它
    expect(result.text?.endsWith(backupPath)).toBe(true);
    // 正文与替换消息里的 <handoff> 段逐字一致（备份只多一个收尾换行）
    expect(fs.readFileSync(backupPath, 'utf8')).toBe(`${doc}\n`);
  });
});

describe('runHandoff：守卫', () => {
  it('有未闭合的轮次 → busy 文案，什么都不写', async () => {
    const handle = fakeSession({
      events: [...BASE_EVENTS, { seq: 6, type: 'turn/start' }],
      surface: BASE_SURFACE,
    });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result).toEqual({ kind: 'error', text: BUSY_TEXT });
    expectNoWrites(handle);
    expect(llm.calls).toEqual([]);
  });

  it('压缩正在进行 → busy 文案，什么都不写', async () => {
    const handle = fakeSession({
      events: [...BASE_EVENTS, { seq: 6, type: 'compaction/start' }],
      surface: BASE_SURFACE,
    });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result).toEqual({ kind: 'error', text: BUSY_TEXT });
    expectNoWrites(handle);
    expect(llm.calls).toEqual([]);
  });

  it('轮次已闭合 → 不算 busy', async () => {
    const handle = fakeSession({
      events: [...BASE_EVENTS, { seq: 6, type: 'turn/start' }, { seq: 7, type: 'turn/end' }],
      surface: BASE_SURFACE,
    });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result.kind).toBe('success');
    expect(result.sourceEventSeq).toBe(8);
  });

  it('没有可交接的历史 → 对应文案，什么都不写（与 /compact 一样算成功）', async () => {
    const handle = fakeSession({
      events: [{ seq: 0, type: 'system/message' }],
      surface: [0],
    });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result).toEqual({ kind: 'success', text: NO_HISTORY_TEXT });
    expectNoWrites(handle);
    expect(llm.calls).toEqual([]);
  });
});

describe('runHandoff：失败与取消', () => {
  it('摘要没有产出 → 交接单生成失败，无 append、无备份', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm([]);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result).toEqual({ kind: 'error', text: SUMMARY_FAILED_TEXT });
    expectNoWrites(handle);
    expect(llm.calls).toHaveLength(1);
  });

  it('摘要被模型截断 → 同样是交接单生成失败', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm([
      { type: 'text-delta', index: 0, text: '# 交接：半份' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result).toEqual({ kind: 'error', text: SUMMARY_FAILED_TEXT });
    expectNoWrites(handle);
  });

  it('备份写失败 → 备份写入失败，且绝不 append', async () => {
    const blocker = path.join(tmp, 'not-a-directory');
    fs.writeFileSync(blocker, 'x', 'utf8');
    process.env['HANDOFF_HOME'] = blocker;

    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result).toEqual({ kind: 'error', text: BACKUP_FAILED_TEXT });
    expect(handle.appends).toEqual([]);
  });

  it('摘要期间 surface 变了 → 会话变化文案，无 append、无备份', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(() => {
      // 模拟摘要期间又有一步落进会话
      handle.addEvent({ seq: 6, type: 'user/message', sourceKind: 'user' });
      handle.setSurface([...BASE_SURFACE, 6]);
      return OK_CHUNKS;
    });
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent));

    expect(result).toEqual({ kind: 'error', text: CHANGED_TEXT });
    expectNoWrites(handle);
  });

  it('开始前已取消 → 取消文案，不调模型、不写任何东西', async () => {
    const controller = new AbortController();
    controller.abort();

    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent, controller.signal));

    expect(result).toEqual({ kind: 'error', text: CANCELLED_TEXT });
    expectNoWrites(handle);
    expect(llm.calls).toEqual([]);
  });

  it('摘要期间取消 → 取消文案，不写备份、不 append', async () => {
    const controller = new AbortController();

    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(() => {
      controller.abort();
      return [{ type: 'finish', reason: { kind: 'aborted' } }];
    });
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent, controller.signal));

    expect(result).toEqual({ kind: 'error', text: CANCELLED_TEXT });
    expectNoWrites(handle);
  });

  it('摘要完成、备份之前的取消 → 取消文案，不写备份', async () => {
    const controller = new AbortController();

    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(() => {
      // 模型已回完、进入收尾阶段时用户点了取消
      controller.abort();
      return OK_CHUNKS;
    });
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent, controller.signal));

    expect(result).toEqual({ kind: 'error', text: CANCELLED_TEXT });
    expectNoWrites(handle);
  });

  it('备份已写、append 之前的取消 → 取消文案并报出备份路径，会话不动', async () => {
    const controller = new AbortController();
    backupHook.afterWrite = () => {
      controller.abort();
    };

    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(OK_CHUNKS);
    const agent = { session: handle.session, options: { provider: 'p', model: 'm' } };

    const result = await runHandoff(llm.ctx, invocationOf(agent, controller.signal));

    expect(result.kind).toBe('error');
    expect(result.text).toContain(CANCELLED_TEXT);
    expect(handle.appends).toEqual([]);
    // 备份是这次唯一落盘的东西：文件在，会话没改
    const files = backupFiles();
    expect(files).toHaveLength(1);
    expect(result.text).toContain(path.join(home, files[0] as string));
    expect(handle.session.surface.nodes).toEqual(BASE_SURFACE);
  });

  it('调用现场没有会话 → 兜底错误，不抛异常', async () => {
    const llm = fakeLlm(OK_CHUNKS);
    let result: HandoffCommandResult | undefined;
    await expect(
      (async () => {
        result = await runHandoff(llm.ctx, invocationOf({ options: { provider: 'p', model: 'm' } }));
      })(),
    ).resolves.toBeUndefined();
    expect(result?.kind).toBe('error');
    expect(result?.text).toContain('交接未执行');
  });
});

describe('surfaceViews：surface 的数字 seq → SurfaceNode 映射', () => {
  // 真实事件形状（dsh-session 的 deriveEventMessage）：
  //   system/message / developer/message 的 message 在 data.message 下
  //   user/message 的 data 就是 message 本身 → 工作区指令基线是 data.source.kind
  // 取错层级会让 pinned 掉到 0，替换区间从节点 0 开始，append 时
  // assertSystemHeadRewrite 直接抛 "node 0 holds the system prompt"。
  const EVENTS: readonly HandoffEventView[] = [
    { type: 'system/message', data: { message: { source: { kind: 'system-prompt' } } } },
    { type: 'user/message', data: { source: { kind: 'agent-instructions' } } },
    { type: 'user/message', data: { source: { kind: 'user' } } },
  ];

  function surfaceSource(
    nodes: readonly number[],
  ): Pick<HandoffSession, 'surface' | 'eventAt'> {
    return { surface: { nodes }, eventAt: (seq: number) => EVENTS[seq] };
  }

  it('type 与 sourceKind 正确，pinned 不是 0（节点 0 绝不能被遮蔽）', () => {
    const views = surfaceViews(surfaceSource([0, 1, 2]));

    expect(views).toEqual([
      { seq: 0, type: 'system/message' },
      { seq: 1, type: 'user/message', sourceKind: 'agent-instructions' },
      { seq: 2, type: 'user/message', sourceKind: 'user' },
    ]);
    expect(views[1]?.sourceKind).toBe('agent-instructions');

    const pinned = pinnedNodeCount(views);
    // system 头 + 工作区指令基线
    expect(pinned).toBe(2);
    expect(pinned).toBeGreaterThan(0);
    // 关键防回归：替换区间从第 2 个节点开始，而不是节点 0
    expect(shadowedRange([0, 1, 2], pinned)).toEqual({ startSeq: 2, endSeq: 2, seqs: [2] });
  });

  it('system 头 + 普通 user（没有基线）时 pinned 恰好是 1，不是 0', () => {
    const views = surfaceViews(surfaceSource([0, 2]));

    expect(views).toEqual([
      { seq: 0, type: 'system/message' },
      { seq: 2, type: 'user/message', sourceKind: 'user' },
    ]);
    expect(pinnedNodeCount(views)).toBe(1);
  });

  it('surface 引用了不存在的事件 → 抛错，不猜', () => {
    expect(() => surfaceViews(surfaceSource([0, 9]))).toThrow(/seq 9/);
  });
});
