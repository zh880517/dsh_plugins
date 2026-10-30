// 两条动作链的可测内核：用假 sessions / fetch 断言调用顺序与失败分支。
//
// 重点是新会话链：draft 成功之后必须 create → using(prompt) → openSession，
// 且任何一步失败都**不**切会话；doc 为空时一步都不往下走。
import { describe, expect, it } from 'vitest';

import {
  handoffInPlace,
  handoffToNewSession,
  type NewSessionDeps,
  type SessionsFacade,
} from '../../plugins/handoff/src/actions.js';

const DOC = '# 交接：T10\n\n## 下一步\n跑测试。';
const BUSY_TEXT = '当前有轮次正在运行或压缩正在进行，交接暂不可用。';

interface Harness {
  readonly deps: NewSessionDeps;
  readonly calls: string[];
  readonly prompts: Array<{ content: unknown; mode: string }>;
}

type UsingFn = NonNullable<SessionsFacade['using']>;
type RetainFn = NonNullable<SessionsFacade['retain']>;
type BindingFn = NonNullable<SessionsFacade['binding']>;

/** 一套可观察的假依赖；默认走 0.2 的 using 路径（doc 有内容、create 返回新 id、prompt ok）。 */
function harness(overrides: {
  draft?: () => Promise<{ status: number; body: unknown }>;
  create?: SessionsFacade['create'];
  /** `null` = 这个运行时没有 `using`（用来测回退链）；省略 = 默认的 using 实现。 */
  using?: UsingFn | null;
  retain?: RetainFn;
  binding?: BindingFn;
  openSession?: (id: string) => void;
} = {}): Harness {
  const calls: string[] = [];
  const prompts: Array<{ content: unknown; mode: string }> = [];

  const createImpl: SessionsFacade['create'] = overrides.create ?? (async () => 'session-new');
  const usingImpl: UsingFn =
    overrides.using ??
    (async (_target, _options, operation) =>
      operation({
        binding: {
          session: {
            prompt: async (content: unknown, mode: string) => {
              prompts.push({ content, mode });
              calls.push(`prompt:${mode}`);
              return { ok: true };
            },
          },
        },
      }));

  const sessions: SessionsFacade = {
    create: async (options) => {
      calls.push(
        'workspaceId' in options ? `create:ws=${options.workspaceId}` : `create:cwd=${options.cwd}`,
      );
      return createImpl(options);
    },
  };
  if (overrides.using !== null) {
    sessions.using = async (target, options, operation) => {
      calls.push(`using:${target}:${options.source}`);
      return usingImpl(target, options, operation);
    };
  }
  if (overrides.retain !== undefined) sessions.retain = overrides.retain;
  if (overrides.binding !== undefined) sessions.binding = overrides.binding;

  const deps: NewSessionDeps = {
    sessions,
    uiWorkspace: {
      openSession: (id) => {
        calls.push(`open:${id}`);
        overrides.openSession?.(id);
      },
    },
    readDraft: async (sessionId) => {
      calls.push(`draft:${sessionId}`);
      if (overrides.draft !== undefined) return overrides.draft();
      return { status: 200, body: { ok: true, doc: DOC, shadowable: 3 } };
    },
  };

  return { deps, calls, prompts };
}

const signal = new AbortController().signal;

describe('handoffInPlace：就地交接', () => {
  it('只调用 commands.execute(session, "/handoff", [])，透传 Host 文案', async () => {
    const calls: unknown[][] = [];
    const outcome = await handoffInPlace(
      {
        commands: {
          execute: async (...args: unknown[]) => {
            calls.push(args);
            return { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '已交接。' } } };
          },
        },
      },
      'session-1',
    );
    expect(outcome).toEqual({ kind: 'success', text: '已交接。' });
    expect(calls).toEqual([['session-1', '/handoff', []]]);
  });

  it('busy 等失败原因原样返回；命令抛异常收敛为“失败无文案”', async () => {
    const busy = await handoffInPlace(
      { commands: { execute: async () => ({ ok: true, value: { commandId: 'c', result: { kind: 'error', text: BUSY_TEXT } } }) } },
      'session-1',
    );
    expect(busy).toEqual({ kind: 'error', text: BUSY_TEXT, reason: 'command' });

    const thrown = await handoffInPlace(
      {
        commands: {
          execute: async () => {
            throw new Error('transport closed');
          },
        },
      },
      'session-1',
    );
    expect(thrown).toEqual({ kind: 'error', text: null, reason: 'transport' });
  });
});

describe('handoffToNewSession：draft → create → prompt → openSession', () => {
  it('成功链路：顺序固定，首条 prompt 是交接单、queue 模式，最后才切会话', async () => {
    const { deps, calls, prompts } = harness();
    const outcome = await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal);

    expect(outcome).toEqual({ kind: 'moved', sessionId: 'session-new' });
    expect(calls).toEqual([
      'draft:session-1',
      'create:cwd=D:/proj',
      'using:session-new:handoff',
      'prompt:queue',
      'open:session-new',
    ]);
    expect(prompts).toEqual([{ content: [{ type: 'text', text: DOC }], mode: 'queue' }]);
  });

  it('prompt 以 session 实例为 this 调用（真实 Session.prompt 是读 this 的类方法）', async () => {
    let receiver: unknown;
    const session = {
      prompt: async function (this: unknown): Promise<{ ok: true }> {
        receiver = this;
        return { ok: true };
      },
    };
    const { deps } = harness({
      using: async (_target, _options, operation) => operation({ binding: { session } }),
    });

    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal)).toEqual({
      kind: 'moved',
      sessionId: 'session-new',
    });
    expect(receiver).toBe(session);
  });

  it('没有可交接的历史：直接结束，绝不 create', async () => {
    const { deps, calls } = harness({
      draft: async () => ({ status: 200, body: { ok: true, doc: null, shadowable: 0 } }),
    });
    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal)).toEqual({ kind: 'empty' });
    expect(calls).toEqual(['draft:session-1']);
  });

  it('生成期间关掉面板（signal 已取消）：不 create、不切会话', async () => {
    const { deps, calls } = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, controller.signal)).toEqual({
      kind: 'cancelled',
    });
    expect(calls).toEqual(['draft:session-1']);
  });

  it('draft 失败：透传 Host 文案与 HTTP 状态，不 create', async () => {
    const { deps, calls } = harness({
      draft: async () => ({ status: 409, body: { ok: false, error: { code: 'busy', message: BUSY_TEXT } } }),
    });
    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal)).toEqual({
      kind: 'error',
      stage: 'draft',
      text: BUSY_TEXT,
      status: 409,
    });
    expect(calls).toEqual(['draft:session-1']);
  });

  it('网络层失败：没有 Host 文案，也不 create', async () => {
    const { deps, calls } = harness({
      draft: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal)).toEqual({
      kind: 'error',
      stage: 'draft',
      text: null,
    });
    expect(calls).toEqual(['draft:session-1']);
  });

  it('既没有 workspaceId 也没有 cwd：fail fast，不白跑一次模型摘要', async () => {
    const { deps, calls } = harness();
    expect(await handoffToNewSession(deps, 'session-1', {}, signal)).toEqual({
      kind: 'error',
      stage: 'cwd',
      text: null,
    });
    expect(await handoffToNewSession(deps, 'session-1', { cwd: '', workspaceId: '' }, signal)).toEqual({
      kind: 'error',
      stage: 'cwd',
      text: null,
    });
    expect(calls).toEqual([]);
  });

  it('create 失败：不 prompt、不切会话', async () => {
    const { deps, calls } = harness({
      create: async () => {
        throw new Error('session create failed: workspace/unknown');
      },
    });
    const outcome = await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal);
    expect(outcome.kind).toBe('error');
    expect(outcome).toMatchObject({ stage: 'create', text: 'session create failed: workspace/unknown' });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj']);
  });

  it('prompt 被 Host 拒绝：展示 Host 文案，不切会话', async () => {
    const { deps, calls } = harness({
      using: async (_target, _options, operation) =>
        operation({
          binding: {
            session: {
              prompt: async () => ({ ok: false, error: { code: 'agent/busy', message: '当前有轮次正在运行。' } }),
            },
          },
        }),
    });
    const outcome = await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal);
    expect(outcome).toMatchObject({ kind: 'error', stage: 'prompt', text: '当前有轮次正在运行。' });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj', 'using:session-new:handoff']);
  });

  it('会话引用没有 prompt：收敛为 prompt 阶段失败，不切会话', async () => {
    const { deps, calls } = harness({
      using: async (_target, _options, operation) => operation({ binding: {} }),
    });
    const outcome = await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal);
    expect(outcome).toMatchObject({ kind: 'error', stage: 'prompt' });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj', 'using:session-new:handoff']);
  });

  it('有 workspaceId：create 收到 workspaceId（宿主才会 attachSession），不用 cwd', async () => {
    const { deps, calls } = harness();
    const outcome = await handoffToNewSession(
      deps,
      'session-1',
      { workspaceId: 'ws-42', cwd: 'D:/proj' },
      signal,
    );

    expect(outcome).toEqual({ kind: 'moved', sessionId: 'session-new' });
    expect(calls).toEqual([
      'draft:session-1',
      'create:ws=ws-42',
      'using:session-new:handoff',
      'prompt:queue',
      'open:session-new',
    ]);
  });

  it('只有 workspaceId、没有 cwd 也能建会话（cwd 由宿主的 workspace.path 提供）', async () => {
    const { deps, calls } = harness();
    expect(await handoffToNewSession(deps, 'session-1', { workspaceId: 'ws-42' }, signal)).toEqual({
      kind: 'moved',
      sessionId: 'session-new',
    });
    expect(calls).toEqual([
      'draft:session-1',
      'create:ws=ws-42',
      'using:session-new:handoff',
      'prompt:queue',
      'open:session-new',
    ]);
  });

  it('abort 在 create 之后、prompt 之前：不 prompt、不切会话', async () => {
    const controller = new AbortController();
    const { deps, calls, prompts } = harness({
      create: async () => {
        controller.abort();
        return 'session-new';
      },
    });

    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, controller.signal)).toEqual({
      kind: 'cancelled',
    });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj']);
    expect(prompts).toEqual([]);
  });

  it('abort 在 prompt 之后：仍然切到新会话（不许留一个后台跑 turn 的不可见会话）', async () => {
    const controller = new AbortController();
    const { deps, calls } = harness({
      using: async (_target, _options, operation) =>
        operation({
          binding: {
            session: {
              prompt: async () => {
                controller.abort();
                return { ok: true };
              },
            },
          },
        }),
    });

    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, controller.signal)).toEqual({
      kind: 'moved',
      sessionId: 'session-new',
    });
    expect(calls).toEqual([
      'draft:session-1',
      'create:cwd=D:/proj',
      'using:session-new:handoff',
      'open:session-new',
    ]);
  });

  it('using 的 abort（retain 的 throwIfAborted）收敛为 cancelled，不切会话', async () => {
    const controller = new AbortController();
    const { deps, calls } = harness({
      using: async () => {
        // 真实实现里 retain 会同步 throwIfAborted()，attachOpening 也会以 abort 拒付。
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    });

    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, controller.signal)).toEqual({
      kind: 'cancelled',
    });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj', 'using:session-new:handoff']);
  });
});

describe('handoffToNewSession：运行时 API 探测与回退链', () => {
  it('没有 using、只有 retain：retain → ready → prompt → release → open（0.2 的显式回退）', async () => {
    const { deps, calls, prompts } = harness({
      using: null,
      retain: (target, options) => {
        calls.push(`retain:${target}:${options.source}`);
        return {
          ready: Promise.resolve().then(() => {
            calls.push('ready');
          }),
          binding: {
            session: {
              prompt: async (content: unknown, mode: string) => {
                prompts.push({ content, mode });
                calls.push(`prompt:${mode}`);
                return { ok: true };
              },
            },
          },
          release: () => {
            calls.push('release');
          },
        };
      },
    });

    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal)).toEqual({
      kind: 'moved',
      sessionId: 'session-new',
    });
    expect(calls).toEqual([
      'draft:session-1',
      'create:cwd=D:/proj',
      'retain:session-new:handoff',
      'ready',
      'prompt:queue',
      'release',
      'open:session-new',
    ]);
    expect(prompts).toEqual([{ content: [{ type: 'text', text: DOC }], mode: 'queue' }]);
  });

  it('retain 的 ready 拒绝：仍然 release，不 prompt、不切会话', async () => {
    const { deps, calls, prompts } = harness({
      using: null,
      retain: (target) => {
        calls.push(`retain:${target}`);
        return {
          ready: (async () => {
            throw new Error('open failed');
          })(),
          release: () => {
            calls.push('release');
          },
        };
      },
    });

    const outcome = await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal);
    expect(outcome).toMatchObject({ kind: 'error', stage: 'prompt', text: 'open failed' });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj', 'retain:session-new', 'release']);
    expect(prompts).toEqual([]);
  });

  it('retain 期间 abort：release 归还引用，不 prompt、不切会话', async () => {
    const controller = new AbortController();
    const { deps, calls, prompts } = harness({
      using: null,
      retain: (target) => {
        calls.push(`retain:${target}`);
        controller.abort();
        return {
          ready: Promise.resolve(),
          release: () => {
            calls.push('release');
          },
        };
      },
    });

    expect(
      await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, controller.signal),
    ).toEqual({ kind: 'cancelled' });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj', 'retain:session-new', 'release']);
    expect(prompts).toEqual([]);
  });

  it('没有 using/retain、create 返回 id：binding(id) 解析 SessionFace 后直接 prompt（0.1.5）', async () => {
    const { deps, calls, prompts } = harness({
      using: null,
      binding: (id) => {
        calls.push(`binding:${id}`);
        return {
          session: {
            prompt: async (content: unknown, mode: string) => {
              prompts.push({ content, mode });
              calls.push(`prompt:${mode}`);
              return { ok: true };
            },
          },
        };
      },
    });

    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal)).toEqual({
      kind: 'moved',
      sessionId: 'session-new',
    });
    expect(calls).toEqual([
      'draft:session-1',
      'create:cwd=D:/proj',
      'binding:session-new',
      'prompt:queue',
      'open:session-new',
    ]);
    expect(prompts).toEqual([{ content: [{ type: 'text', text: DOC }], mode: 'queue' }]);
  });

  it('create 直接返回带 prompt 的 session 对象：不经过 using/retain/binding，直接发首条消息', async () => {
    const { deps, calls, prompts } = harness({
      using: null,
      create: async () => ({
        sessionId: 'session-new',
        prompt: async (content: unknown, mode: string) => {
          prompts.push({ content, mode });
          calls.push(`prompt:${mode}`);
          return { ok: true };
        },
      }),
    });

    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal)).toEqual({
      kind: 'moved',
      sessionId: 'session-new',
    });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj', 'prompt:queue', 'open:session-new']);
    expect(prompts).toEqual([{ content: [{ type: 'text', text: DOC }], mode: 'queue' }]);
  });

  it('using / retain / binding / 会话对象都没有：明确失败并带回交接单', async () => {
    const { deps, calls, prompts } = harness({ using: null });

    expect(await handoffToNewSession(deps, 'session-1', { cwd: 'D:/proj' }, signal)).toEqual({
      kind: 'error',
      stage: 'unsupported',
      text: '当前 DSH 版本不支持自动创建会话，请手动新建会话后粘贴交接单。',
      doc: DOC,
    });
    expect(calls).toEqual(['draft:session-1', 'create:cwd=D:/proj']);
    expect(prompts).toEqual([]);
  });
});
