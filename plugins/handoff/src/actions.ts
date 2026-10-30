// 两条交接动作链：就地交接与新会话交接。
//
// 依赖全部从参数注入（commands / sessions / uiWorkspace / readDraft），所以
// tests/handoff/client-actions.test.ts 可以用假对象断言调用顺序 —— 尤其是新会话
// “create → prompt → openSession”这条链，以及失败时**不**切会话。
//
// 新会话链按运行时**实际有**的 API 选择路径（不猜版本号，只做结构探测）：
//   1. `sessions.using`          —— 0.2.x 首选（create + using + prompt + openSession）
//   2. `sessions.retain`         —— 0.2.x 的显式回退（using 缺席时手工 retain / ready / release）
//   3. `sessions.binding(id)`    —— 0.1.5：create 返回 id，binding 解析出 SessionFace
//   4. create() 直接返回 session —— 更保守的形状（对象自带 prompt，直接发）
// 四者都没有时明确失败，并把交接单（doc）带回给上层做降级展示。
//
// 这里不碰 React / DOM / 全局 fetch：readDraft 由 client.tsx 用 resolveEndpoint + fetch 实现。
import { classifyCommand, classifyDraft, type CommandOutcome } from './logic.js';

/** `ctx.remote.commands` 里本模块用到的一点。 */
export interface CommandExecutor {
  execute(sessionId: string, command: string, parts: readonly unknown[]): Promise<unknown>;
}

/**
 * 一个能发首条消息的会话句柄（结构探测用，不 import 任何 `@deepseek-ai/*`）。
 *
 * 真实 `prompt` 的签名是 `(content, mode, signal?, requestId?)`；这里只要求
 * “存在且是函数”，调用处再按 0.1.5 / 0.2 共有的前两个参数发，并用 `.call(session)`
 * 保住 `this` —— 两个版本的 `Session` 都是类方法，脱离实例调用会读不到字段。
 */
export interface PromptableSession {
  readonly prompt?: unknown;
  /** 极少数形状可能把 id 挂在 session 对象上；0.1.5 的 create 直接返回 id。 */
  readonly sessionId?: unknown;
}

/** `sessions.retain()` 返回的会话引用（0.2.1-rc.5 的 ClientSessionReference 形状）。 */
export interface RetainedSessionReference {
  readonly ready?: Promise<unknown>;
  readonly binding?: { readonly session?: PromptableSession };
  release?(): void;
}

/**
 * `ctx.sessions`（Client Session Controller）里本模块用到的一点。
 *
 * 三种运行时的形状不同，所以除 `create` 外全部可选，靠 `typeof === 'function'` 探测：
 * - 0.2.x：有 `using`（首选），也有 `retain`；
 * - 0.1.5：**没有** `using` / `retain`，但 `create` 返回 id 且 `binding(id)` 能同步
 *   解析出 SessionFace；
 * - 更保守的形状：`create` 可能直接返回带 `prompt` 的 session 对象。
 *
 * `create` 二选一：给 `workspaceId` 时宿主用工作区路径当 cwd，并把它
 * `attachSession` 进该工作区（否则新会话会落到侧栏的 Ungrouped）；没有工作区
 * 才退回 `cwd`（那个分支不 attach）。
 */
export interface SessionsFacade {
  create(options: { workspaceId: string } | { cwd: string }): Promise<string | PromptableSession>;
  using?<T>(
    target: string,
    options: { source: string; signal?: AbortSignal },
    operation: (reference: unknown) => Promise<T>,
  ): Promise<T>;
  retain?(
    target: string,
    options: { source: string; signal?: AbortSignal },
  ): RetainedSessionReference;
  binding?(id: string): { readonly session?: PromptableSession } | undefined;
}

/** 新会话的落点：优先工作区，其次当前会话的 cwd。 */
export interface NewSessionTarget {
  readonly workspaceId?: string | undefined;
  readonly cwd?: string | undefined;
}

/** `using` 里“还没发 prompt 就已被取消”的内部哨兵，不能与 `prompt()` 的任何返回值混淆。 */
const ABORTED = Symbol('handoff-aborted');

/** 首条消息函数；`this` 必须是 session 实例（两个版本的 `prompt` 都是类方法）。 */
type PromptFn = (
  this: PromptableSession,
  content: readonly unknown[],
  mode: string,
) => Promise<unknown>;

/** 三种运行时的建会话 API 都不存在时的明确失败文案（Host 文案是中文，保持一致）。 */
const UNSUPPORTED_TEXT = '当前 DSH 版本不支持自动创建会话，请手动新建会话后粘贴交接单。';

/** `ctx.uiWorkspace` 里本模块用到的一点。 */
export interface WorkspaceFacade {
  openSession(sessionId: string): void;
}

/** 读取 `GET /handoff/draft` 的一次响应。 */
export type DraftReader = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<{ readonly status: number; readonly body: unknown }>;

/** 新会话链的依赖。 */
export interface NewSessionDeps {
  readonly sessions: SessionsFacade;
  readonly uiWorkspace: WorkspaceFacade;
  readonly readDraft: DraftReader;
}

/** 就地交接的依赖。 */
export interface InPlaceDeps {
  readonly commands: CommandExecutor;
}

/** 新会话链的归一化结果。 */
export type NewSessionOutcome =
  | { readonly kind: 'moved'; readonly sessionId: string }
  | { readonly kind: 'empty' }
  /** 用户在 prompt 发出之前关掉面板：不再往下走（可能已 create 了空会话，但不发 prompt、不切走）。 */
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'error';
      /** 失败发生在哪一步，决定 UI 用哪条兜底文案。 */
      readonly stage: 'cwd' | 'draft' | 'create' | 'prompt' | 'unsupported';
      /** Host 文案（中文）；`null` 表示没有，交给 UI 兜底。 */
      readonly text: string | null;
      /** stage === 'draft' 时的 HTTP 状态，供 UI 拼 “HTTP xxx”。 */
      readonly status?: number;
      /**
       * 运行时没有可用的建会话 API 时，把交接单原样带回去：
       * 上层可以提示“手动新建会话再粘贴”，而不是把这次摘要丢掉。
       */
      readonly doc?: string;
    };

/** Error 的 message；其它一律没有。 */
export function detailOf(cause: unknown): string | null {
  return cause instanceof Error && cause.message !== '' ? cause.message : null;
}

/** 取会话句柄的 `prompt`；没有就 undefined（只探测形状，不猜版本号）。 */
function promptOf(session: PromptableSession | undefined): PromptFn | undefined {
  return session !== undefined && typeof session.prompt === 'function'
    ? (session.prompt as PromptFn)
    : undefined;
}

/** `prompt()` 结果的归一：成功返回 undefined，失败返回 Host 文案（或 `null`）。 */
function promptFailureOf(result: unknown): { readonly text: string | null } | undefined {
  const shaped = result as { ok?: unknown; error?: { message?: unknown } } | null | undefined;
  if (shaped !== null && typeof shaped === 'object' && shaped.ok === true) return undefined;
  return { text: typeof shaped?.error?.message === 'string' ? shaped.error.message : null };
}

/**
 * 就地交接：走和斜杠菜单同一条 `commands.execute` 通道（不写 composer、不 submit）。
 *
 * 成功时 `text` 可能是 Host 的中文确认文案；失败时（busy / 无历史 / 会话变化）也是
 * Host 的中文原因，原样交给 UI。
 */
export async function handoffInPlace(deps: InPlaceDeps, sessionId: string): Promise<CommandOutcome> {
  if (sessionId === '') return { kind: 'error', text: null, reason: 'transport' };
  try {
    return classifyCommand(await deps.commands.execute(sessionId, '/handoff', []));
  } catch {
    return { kind: 'error', text: null, reason: 'transport' };
  }
}

/**
 * 新会话交接：draft → create → 首条 prompt → openSession。
 *
 * `ctx.sessions.create` **不接受** prompt（只有 workspaceId / cwd / sessionId / agentPreset），
 * 所以首条消息必须另发。按运行时实际拥有的 API 依次尝试：
 *
 * 1. `using`（0.2.x）：借一个已 retain 的会话引用，`reference.binding.session.prompt`；
 * 2. `retain`（0.2.x，`using` 缺席时）：create → retain → `reference.ready` →
 *    `reference.binding.session.prompt` → `reference.release()`；
 * 3. `binding(id)`（0.1.5）：create 返回 id，`binding(id).session.prompt`；
 * 4. `create()` 直接返回带 `prompt` 的 session 对象（更保守的形状）。
 *
 * 四者都没有时返回 `stage: 'unsupported'` 并带上 `doc`，让上层提示手动新建会话。
 * 结构探测只认 `typeof x === 'function'`，不看版本号字符串。全程不碰旧会话。
 *
 * 取消语义（面板关掉时 abort）：
 * - draft 期间、create 之后 / prompt 之前：停在原地，不 prompt、不切会话；
 * - prompt 一旦发出去就收不回：照常 `openSession`，让用户看见那个真在跑的会话，
 *   而不是假装取消、留一个后台跑 turn 的不可见会话。
 *
 * @param target - 新会话落点：`workspaceId`（宿主会 attach 到工作区）优先，否则 `cwd`。
 * @param signal - 取消信号；会一并传给 `using` / `retain`（两者都响应它）。
 */
export async function handoffToNewSession(
  deps: NewSessionDeps,
  sessionId: string,
  target: NewSessionTarget,
  signal: AbortSignal,
): Promise<NewSessionOutcome> {
  if (sessionId === '') return { kind: 'error', stage: 'draft', text: null };
  const workspaceId = target.workspaceId;
  const cwd = target.cwd;
  const hasWorkspace = workspaceId !== undefined && workspaceId !== '';
  if (!hasWorkspace && (cwd === undefined || cwd === '')) {
    return { kind: 'error', stage: 'cwd', text: null };
  }

  let response: { readonly status: number; readonly body: unknown };
  try {
    response = await deps.readDraft(sessionId, signal);
  } catch {
    // 网络层失败没有 Host 文案；调用方（UI）用“无法连接 Host”兜底。
    return { kind: 'error', stage: 'draft', text: null };
  }

  const draft = classifyDraft(response.status, response.body);
  if (draft.kind === 'empty') return { kind: 'empty' };
  if (draft.kind === 'error') {
    return { kind: 'error', stage: 'draft', text: draft.text, status: response.status };
  }
  // 摘要是最长的一段；这期间用户关掉面板就到此为止，不留下一个新会话。
  if (signal.aborted) return { kind: 'cancelled' };

  const sessions = deps.sessions;
  if (typeof sessions.create !== 'function') {
    // 连 create 都没有：只有拿到 draft 之后才能确定没有任何可用路径，顺带把 doc 带回去。
    return { kind: 'error', stage: 'unsupported', text: UNSUPPORTED_TEXT, doc: draft.doc };
  }

  let created: string | PromptableSession;
  try {
    created = hasWorkspace
      ? await sessions.create({ workspaceId: workspaceId as string })
      : await sessions.create({ cwd: cwd as string });
  } catch (cause) {
    return { kind: 'error', stage: 'create', text: detailOf(cause) };
  }
  if (typeof created === 'string' && created === '') {
    return { kind: 'error', stage: 'create', text: null };
  }
  if (typeof created !== 'string' && (created === null || typeof created !== 'object')) {
    return { kind: 'error', stage: 'create', text: null };
  }
  // create 之后、prompt 之前关掉面板：会话已建但一条消息都没发，不要让它留在后台。
  if (signal.aborted) return { kind: 'cancelled' };

  const createdId = typeof created === 'string' ? created : undefined;
  const using = sessions.using;
  const retain = sessions.retain;
  const binding = sessions.binding;

  /** 本次实际打开的会话 id；`undefined` 表示 create 返回的对象没带 id。 */
  let openedId: string | undefined;
  let promptResult: unknown;

  if (createdId !== undefined && typeof using === 'function') {
    // 路径 1（0.2.x 首选，行为保持不变）：create → using(prompt) → openSession。
    openedId = createdId;
    try {
      promptResult = await using.call(
        sessions,
        createdId,
        { source: 'handoff', signal },
        async (reference: unknown) => {
          // 进入 using 到真正 prompt 之间还有 await（reference.ready）；再查一次。
          if (signal.aborted) return ABORTED;
          const session = (
            reference as { binding?: { session?: PromptableSession } } | undefined
          )?.binding?.session;
          const prompt = promptOf(session);
          if (session === undefined || prompt === undefined) {
            throw new Error('session reference has no prompt()');
          }
          // `.call(session)`：两个版本的 prompt 都是类方法，脱离实例调用会读不到 this 上的字段。
          return prompt.call(session, [{ type: 'text', text: draft.doc }], 'queue');
        },
      );
    } catch (cause) {
      // `retain` 的 throwIfAborted / attachOpening 的 abort 都从这里出来。
      if (signal.aborted) return { kind: 'cancelled' };
      return { kind: 'error', stage: 'prompt', text: detailOf(cause) };
    }
  } else if (createdId !== undefined && typeof retain === 'function') {
    // 路径 2（0.2.x 的 retain 回退）：using 本质就是 retain + await ready + finally release，
    // 没有 using 时按同一语义手写。服务 0.2.1-rc.5 这类“有 retain、没有 using”的运行时。
    openedId = createdId;
    let reference: RetainedSessionReference | undefined;
    try {
      reference = retain.call(sessions, createdId, { source: 'handoff', signal });
      await reference?.ready;
      if (signal.aborted) {
        promptResult = ABORTED;
      } else {
        const session = reference?.binding?.session;
        const prompt = promptOf(session);
        if (session === undefined || prompt === undefined) {
          throw new Error('session reference has no prompt()');
        }
        promptResult = await prompt.call(session, [{ type: 'text', text: draft.doc }], 'queue');
      }
    } catch (cause) {
      if (signal.aborted) return { kind: 'cancelled' };
      return { kind: 'error', stage: 'prompt', text: detailOf(cause) };
    } finally {
      // 引用必须归还；release 自身失败不能覆盖已经确定的结果。
      try {
        reference?.release?.();
      } catch {
        // 归还失败只影响引用计数，交接结果已经定了。
      }
    }
  } else {
    // 路径 3（0.1.5 形状）：create 返回 id、没有 using/retain，但 binding(id) 能同步解析
    // 出 SessionFace；路径 4（更保守）：create 直接返回带 prompt 的 session 对象。
    const direct = typeof created === 'object' && created !== null ? created : undefined;
    openedId =
      direct !== undefined && typeof direct.sessionId === 'string' && direct.sessionId !== ''
        ? direct.sessionId
        : undefined;
    try {
      let session = direct;
      let prompt = promptOf(session);
      if (prompt === undefined && createdId !== undefined && typeof binding === 'function') {
        session = binding.call(sessions, createdId)?.session;
        prompt = promptOf(session);
        if (prompt !== undefined) openedId = createdId;
      }
      if (session === undefined || prompt === undefined) {
        return { kind: 'error', stage: 'unsupported', text: UNSUPPORTED_TEXT, doc: draft.doc };
      }
      if (signal.aborted) return { kind: 'cancelled' };
      promptResult = await prompt.call(session, [{ type: 'text', text: draft.doc }], 'queue');
    } catch (cause) {
      if (signal.aborted) return { kind: 'cancelled' };
      return { kind: 'error', stage: 'prompt', text: detailOf(cause) };
    }
  }

  if (promptResult === ABORTED) return { kind: 'cancelled' };

  const failure = promptFailureOf(promptResult);
  if (failure !== undefined) {
    return { kind: 'error', stage: 'prompt', text: failure.text };
  }

  // prompt 已发出（哪怕此刻 signal 才 aborted）：必须切过去，别留一个看不见的会话在后台跑。
  if (openedId !== undefined && openedId !== '') deps.uiWorkspace.openSession(openedId);
  return { kind: 'moved', sessionId: openedId ?? '' };
}
