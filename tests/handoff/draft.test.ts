// T8 draft 路由：`GET /handoff/draft` 只读草稿（design.md §2 / §3.2 / §10 T8）。
//
// 全部用假 session / 假 ctx（自己造对象，不连真 DSH），`HANDOFF_HOME` 指向临时目录：
// 断言的是「HTTP 契约」与「一条写操作都没有」——append / create / 备份文件目录。
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHandoffDraft } from '../../plugins/handoff/src/draft.js';
import type { HandoffEventView, HandoffSessionView } from '../../plugins/handoff/src/handoff.js';
import { apply } from '../../plugins/handoff/src/host.js';
import {
  HANDOFF_INSTRUCTION,
  type HandoffLlmMessage,
  type HandoffStreamChunk,
  type HandoffStreamOptions,
} from '../../plugins/handoff/src/summarize.js';

// ---- fixtures ----

// 文案逐字写死（不 import HANDOFF_TEXTS）：常量被误改时这里要报警。
const BUSY_TEXT = '当前有轮次正在运行或压缩正在进行，交接暂不可用。';
const SUMMARY_FAILED_TEXT = '交接单生成失败（模型未返回有效内容），未执行。';
const CANCELLED_TEXT = '交接已取消。';

const SUMMARY_TEXT = '# 交接：T8\n\n## 目标\n接上 `GET /handoff/draft`。\n\n## 下一步\n跑 `npx vitest run tests/handoff`。';

/** 一个事件：surface 节点还要带 `source.kind`。 */
interface FakeEvent {
  readonly seq: number;
  readonly type: string;
  readonly sourceKind?: string | undefined;
}

/** 假 Session：只实现守卫 / 摘要 / 事件读取用到的那几处；`append` 只记录，绝不真写。 */
interface FakeSessionLike extends HandoffSessionView {
  requestHeader(): { readonly config: { readonly provider: string; readonly model: string } };
  toolHistory(): unknown;
  append(): never;
}

interface FakeSessionHandle {
  readonly session: FakeSessionLike;
  readonly appends: unknown[];
  readonly deriveCount: () => number;
  setSurface(nodes: readonly number[]): void;
  addEvent(event: FakeEvent): void;
}

function fakeSession(options: {
  readonly events: readonly FakeEvent[];
  readonly surface: readonly number[];
  readonly id?: string;
}): FakeSessionHandle {
  const events: FakeEvent[] = options.events.map((event) => ({ ...event }));
  let surface: number[] = [...options.surface];
  const appends: unknown[] = [];
  let deriveCount = 0;

  const nextSeq = (): number => (events.length === 0 ? 0 : Math.max(...events.map((event) => event.seq)) + 1);

  const session: FakeSessionLike = {
    id: options.id ?? 'session-draft',
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
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
    toolHistory: () => ({ tools: [] }),
    append(): never {
      appends.push({});
      // draft 一旦 append 就是 bug；抛错让测试失败在调用点，而不是静默通过。
      throw new Error('draft 不得 append 事件');
    },
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

/** 一个「system + 工作区指令 + 两轮问答」的会话：pinned = 2，可交接 [2,3,4,5]。 */
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

/** 假 Agent：live Agent 的最小形状（session + options），不是硬凑的模型路由。 */
function fakeAgent(session: FakeSessionLike): {
  session: FakeSessionLike;
  options: { provider: string; model: string };
} {
  return { session, options: { provider: 'p', model: 'm' } };
}

// ---- 假宿主（apply 注册的 handler 直接喂假 req / 假 res）----

interface Mounted {
  readonly handler: (req: unknown, res: unknown) => Promise<void>;
  readonly ctx: any;
  /** draft 若调用 `sessions.create`，这里会记录到（断言为空）。 */
  readonly created: unknown[];
  dispose(): void;
}

function mountHost(options: {
  readonly llm: FakeLlm;
  readonly agents?: ReadonlyMap<string, unknown>;
  readonly sessions?: ReadonlyMap<string, unknown>;
}): Mounted {
  const agents = options.agents ?? new Map<string, unknown>();
  const sessions = options.sessions ?? new Map<string, unknown>();
  const created: unknown[] = [];
  const disposers: Array<() => void> = [];
  let handler: Mounted['handler'] | null = null;

  const ctx = {
    // cordis 的 effect 接受 disposer / Promise / 可迭代 yield 多个；这里按同步形式收敛。
    effect(fn: () => unknown) {
      const result = fn();
      const items: unknown[] = [];
      if (typeof result === 'function') items.push(result);
      else if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
        for (const item of result as Iterable<unknown>) items.push(item);
      }
      for (const item of items) if (typeof item === 'function') disposers.push(item as () => void);
    },
    commands: { register: () => () => {} },
    webServer: {
      register(route: { handler: Mounted['handler'] }) {
        handler = route.handler;
        return () => {};
      },
    },
    sessions: {
      get(id: string) {
        return sessions.get(id);
      },
      create(id: string) {
        created.push(id);
        throw new Error('draft 不得创建会话');
      },
    },
    get(name: string) {
      if (name !== 'agents') return undefined;
      return {
        get(id: string) {
          return agents.get(id);
        },
      };
    },
    llm: options.llm.ctx.llm,
  };

  apply(ctx);
  if (handler === null) throw new Error('host 没有注册 draft 路由');
  return {
    handler,
    ctx,
    created,
    dispose(): void {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

function fakeReq(method: string, url: string, headers: Record<string, string> = {}): unknown {
  const stream = Readable.from([]) as unknown as {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

/**
 * 假 ServerResponse：带 `on/off/emit`（Node 的 close 事件）与 `destroyed` / `writableEnded`，
 * 这样 host.ts 里 `typeof res.on === 'function'` 的守卫能真正走到 abort 分支。
 */
interface FakeRes extends EventEmitter {
  statusCode: number;
  headers: Record<string, string | number>;
  text: string;
  destroyed: boolean;
  writableEnded: boolean;
  setHeader: (name: string, value: string | number) => void;
  end: (chunk?: string | Buffer) => void;
}

function fakeRes(): FakeRes {
  const out = Object.assign(new EventEmitter(), {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    text: '',
    destroyed: false,
    writableEnded: false,
  }) as FakeRes;
  out.setHeader = (name, value) => {
    out.headers[name] = value;
  };
  out.end = (chunk) => {
    out.writableEnded = true;
    if (chunk !== undefined) out.text += chunk.toString();
  };
  return out;
}

async function call(
  mounted: Mounted,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; res: FakeRes }> {
  const res = fakeRes();
  await mounted.handler(fakeReq(method, url, headers), res);
  const json = res.text === '' ? undefined : (JSON.parse(res.text) as any);
  return { status: res.statusCode, json, res };
}

// ---- 环境 ----

let tmp: string;
let home: string;
let mounted: Mounted | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-draft-'));
  home = path.join(tmp, 'handoff');
  process.env['HANDOFF_HOME'] = home;
});

afterEach(() => {
  mounted?.dispose();
  mounted = undefined;
  delete process.env['HANDOFF_HOME'];
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mount(options: Parameters<typeof mountHost>[0]): Mounted {
  mounted = mountHost(options);
  return mounted;
}

/** 备份目录里现有的文件名（目录不存在就是空）。 */
function backupFiles(): string[] {
  return fs.existsSync(home) ? fs.readdirSync(home) : [];
}

/** draft 的硬约束：不 append、不建 session、不写备份。 */
function expectReadOnly(handle: FakeSessionHandle, host: Mounted): void {
  expect(handle.appends).toEqual([]);
  expect(host.created).toEqual([]);
  expect(backupFiles()).toEqual([]);
  expect(fs.existsSync(home)).toBe(false);
}

// ---- tests ----

describe('GET /handoff/draft：成功路径', () => {
  it('返回完整交接单（含 §6 头部注释）与 shadowable，且一条写操作都没有', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE, id: 'session-draft' });
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const { status, json, res } = await call(host, 'GET', '/handoff/draft?session=session-draft');

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    // 遮蔽的是 system + 工作区指令之后的后缀：4 条
    expect(json.shadowable).toBe(4);
    // doc 是完整交接单：头部注释 + 摘要正文，没有 <handoff> 包裹，也没有 PREAMBLE
    expect(json.doc).toMatch(
      /^<!-- handoff: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z from session session-draft \(seq 2\.\.5\) -->\n\n# 交接：T8/,
    );
    expect(json.doc).toContain(SUMMARY_TEXT);
    expect(json.doc).not.toContain('<handoff>');
    expect(json.doc).not.toContain('This conversation was handed off');

    // 摘要回放前缀 = deriveMessages()，指令由 summarize 追加到最后
    expect(handle.deriveCount()).toBe(1);
    const options = llm.calls[0];
    expect(options?.messages.slice(0, BASE_SURFACE.length)).toEqual(
      BASE_SURFACE.map((seq) => ({ role: 'user', content: [{ type: 'text', text: `node-${seq}` }] })),
    );
    expect(options?.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: HANDOFF_INSTRUCTION }],
    });

    expectReadOnly(handle, host);

    // JSON + 同源请求（没有 Origin）不设 ACAO：CORS 只管跨源
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('摘要期间 surface 变了仍然返回草稿（新会话场景不做选区稳定检查）', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(() => {
      // 摘要期间又落了一步：`/handoff` 会因此返回"会话发生了变化"，draft 不会
      handle.addEvent({ seq: 6, type: 'user/message', sourceKind: 'user' });
      handle.setSurface([...BASE_SURFACE, 6]);
      return OK_CHUNKS;
    });
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const { status, json } = await call(host, 'GET', '/handoff/draft?session=session-draft');

    expect(status).toBe(200);
    // 草稿基于变化前的快照：头部区间与条数都还是旧 surface
    expect(json.shadowable).toBe(4);
    expect(json.doc).toContain('(seq 2..5)');
    expectReadOnly(handle, host);
  });
});

describe('GET /handoff/draft：守卫', () => {
  it('没有可交接的历史 → 200 + shadowable 0 + doc null，不调模型', async () => {
    const handle = fakeSession({ events: [{ seq: 0, type: 'system/message' }], surface: [0] });
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const { status, json } = await call(host, 'GET', '/handoff/draft?session=session-draft');

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, doc: null, shadowable: 0 });
    expect(llm.calls).toEqual([]);
    expect(handle.deriveCount()).toBe(0);
    expectReadOnly(handle, host);
  });

  it('有未闭合的轮次 → 409 + busy 文案，不调模型、不写', async () => {
    const handle = fakeSession({
      events: [...BASE_EVENTS, { seq: 6, type: 'turn/start' }],
      surface: BASE_SURFACE,
    });
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const { status, json } = await call(host, 'GET', '/handoff/draft?session=session-draft');

    expect(status).toBe(409);
    expect(json).toEqual({ ok: false, error: { code: 'busy', message: BUSY_TEXT } });
    expect(llm.calls).toEqual([]);
    expectReadOnly(handle, host);
  });

  it('压缩正在进行 → 409 + busy 文案，不调模型', async () => {
    const handle = fakeSession({
      events: [...BASE_EVENTS, { seq: 6, type: 'compaction/start' }],
      surface: BASE_SURFACE,
    });
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const { status, json } = await call(host, 'GET', '/handoff/draft?session=session-draft');

    expect(status).toBe(409);
    expect(json.error.code).toBe('busy');
    expect(llm.calls).toEqual([]);
    expectReadOnly(handle, host);
  });
});

describe('GET /handoff/draft：失败与取消', () => {
  it('摘要没有产出 → 502 + summary-failed 文案，不写', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm([]);
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const { status, json } = await call(host, 'GET', '/handoff/draft?session=session-draft');

    expect(status).toBe(502);
    expect(json).toEqual({ ok: false, error: { code: 'summary-failed', message: SUMMARY_FAILED_TEXT } });
    expect(llm.calls).toHaveLength(1);
    expectReadOnly(handle, host);
  });

  it('session 不存在 → 404 + session-not-found，不调模型', async () => {
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm });

    const { status, json } = await call(host, 'GET', '/handoff/draft?session=session-missing');

    expect(status).toBe(404);
    expect(json).toEqual({
      ok: false,
      error: { code: 'session-not-found', message: '找不到活跃会话 session-missing。' },
    });
    expect(llm.calls).toEqual([]);
    expect(host.created).toEqual([]);
  });

  it('会话存在但没有活跃 Agent → 409 + agent-not-live（不伪造模型路由）', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE, id: 'session-cold' });
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm, sessions: new Map([['session-cold', handle.session]]) });

    const { status, json } = await call(host, 'GET', '/handoff/draft?session=session-cold');

    expect(status).toBe(409);
    expect(json.error.code).toBe('agent-not-live');
    expect(json.error.message).toContain('没有活跃的 Agent');
    expect(llm.calls).toEqual([]);
    expectReadOnly(handle, host);
  });

  it('缺少 session 参数 → 400 + bad-request', async () => {
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm });

    const blank = await call(host, 'GET', '/handoff/draft');
    expect(blank.status).toBe(400);
    expect(blank.json.error.code).toBe('bad-request');

    const empty = await call(host, 'GET', '/handoff/draft?session=%20%20');
    expect(empty.status).toBe(400);
    expect(empty.json.error.code).toBe('bad-request');
    expect(llm.calls).toEqual([]);
  });

  it('开始前已取消（直接调 runHandoffDraft）→ 499 + 取消文案，不查会话、不调模型', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm });

    const result = await runHandoffDraft(host.ctx, 'session-draft', controller.signal);

    expect(result.status).toBe(499);
    expect(result.body).toEqual({ ok: false, error: { code: 'cancelled', message: CANCELLED_TEXT } });
    expect(llm.calls).toEqual([]);
  });

  it('摘要期间取消 → 499 + 取消文案，不写任何东西', async () => {
    const controller = new AbortController();
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(() => {
      controller.abort();
      return [{ type: 'finish', reason: { kind: 'aborted' } }];
    });
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const result = await runHandoffDraft(host.ctx, 'session-draft', controller.signal);

    expect(result.status).toBe(499);
    expect(result.body).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expectReadOnly(handle, host);
  });

  it('客户端断开（res 的 close）→ 摘要收到 aborted signal，之后不再写响应', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const res = fakeRes();
    const llm = fakeLlm(() => {
      // 浏览器关掉请求：socket 已销毁 + close 事件，Host 应 abort 进行中的摘要
      res.destroyed = true;
      res.emit('close');
      return [{ type: 'finish', reason: { kind: 'aborted' } }];
    });
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    await host.handler(fakeReq('GET', '/handoff/draft?session=session-draft'), res);

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.signal?.aborted).toBe(true);
    // 响应没人收：不写 JSON，也不把 writableEnded 置真
    expect(res.text).toBe('');
    expect(res.writableEnded).toBe(false);
    expectReadOnly(handle, host);
  });

  it('插件卸载：先 abort 在飞的 draft，再等它结算（不响应 signal 的适配器也不会卡住 dispose 前的 abort）', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    let seen: AbortSignal | undefined;
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm = {
      calls: [] as HandoffStreamOptions[],
      ctx: {
        llm: {
          stream(options: HandoffStreamOptions): AsyncIterable<HandoffStreamChunk> {
            llm.calls.push(options);
            seen = options.signal;
            started = true;
            // 故意不响应 signal：靠 apply 的 cleanup 先 abort 再 drain 收尾
            return (async function* generate(): AsyncGenerator<HandoffStreamChunk> {
              await gate;
              yield { type: 'finish', reason: { kind: 'aborted' } };
            })();
          },
        },
      },
    };
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const running = host.handler(fakeReq('GET', '/handoff/draft?session=session-draft'), fakeRes());
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });

    host.dispose();
    mounted = undefined; // 已手动 dispose，afterEach 不要再来一次
    // cleanup 的第一件事就是 abort（同步发生），之后才 await 结算
    expect(seen?.aborted).toBe(true);

    release();
    await running;
  });
});

describe('GET /handoff/draft：HTTP 契约', () => {
  it('非 GET → 405', async () => {
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm });

    const { status, json } = await call(host, 'POST', '/handoff/draft?session=session-draft');

    expect(status).toBe(405);
    expect(json.error.code).toBe('method-not-allowed');
  });

  it('OPTIONS → 204 + CORS 头（null origin 放行）', async () => {
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm });
    const res = fakeRes();

    await host.handler(fakeReq('OPTIONS', '/handoff/draft?session=session-draft', { origin: 'null' }), res);

    expect(res.statusCode).toBe(204);
    expect(res.text).toBe('');
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect(res.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('accept, content-type');
  });

  it('同源页面的 Origin 与 Host 相同 → 回显该 origin', async () => {
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm });
    const origin = 'http://127.0.0.1:3707';

    const { res } = await call(host, 'GET', '/handoff/draft?session=session-draft', {
      origin,
      host: '127.0.0.1:3707',
    });

    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it('陌生 origin → 不返回 ACAO（浏览器读不到响应体）', async () => {
    const handle = fakeSession({ events: BASE_EVENTS, surface: BASE_SURFACE });
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm, agents: new Map([['session-draft', fakeAgent(handle.session)]]) });

    const { status, json, res } = await call(host, 'GET', '/handoff/draft?session=session-draft', {
      origin: 'https://evil.example',
      host: '127.0.0.1:3707',
    });

    // 服务端照常应答（同源/非浏览器还能用），但跨源浏览器拿不到这份正文
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('前缀下的其它路径 → 404，不会误跑到草稿逻辑', async () => {
    const llm = fakeLlm(OK_CHUNKS);
    const host = mount({ llm });

    const { status, json } = await call(host, 'GET', '/handoff/draft/extra?session=session-draft');

    expect(status).toBe(404);
    expect(json.error.code).toBe('not-found');
    expect(llm.calls).toEqual([]);
  });

  it('apply 注册的是带插件前缀的 /handoff/draft 路由', () => {
    const llm = fakeLlm(OK_CHUNKS);
    const routes: Array<{ kind: string; path: string }> = [];
    const disposers: Array<() => void> = [];
    const ctx = {
      effect(fn: () => unknown) {
        const result = fn();
        const items: unknown[] = [];
        if (typeof result === 'function') items.push(result);
        else if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
          for (const item of result as Iterable<unknown>) items.push(item);
        }
        for (const item of items) if (typeof item === 'function') disposers.push(item as () => void);
      },
      commands: { register: () => () => {} },
      sessions: { get: () => undefined },
      get: () => undefined,
      llm: llm.ctx.llm,
      webServer: {
        register(route: { kind: string; path: string; handler: unknown }) {
          routes.push({ kind: route.kind, path: route.path });
          return () => {};
        },
      },
    };

    apply(ctx);

    expect(routes).toEqual([{ kind: 'prefix', path: '/handoff/draft' }]);
    for (const dispose of disposers.reverse()) dispose();
  });
});
