// 交接单摘要：一次 `ctx.llm.stream()` 调用。
//
// 这里刻意 **不** import `@deepseek-ai/dsh-llm`：DSH 的包不是本仓库的依赖。真实的
// `ctx.llm` 只用到 `stream(options)`，`agent` 只用到 `session.requestHeader()` /
// `session.id` / `session.toolHistory()` 与 `agent.options`，所以全部用最小结构化
// 接口描述；单测直接传假对象（异步生成器就能当 stream），不需要伪造整个宿主。
//
// 技巧沿用压缩后端 `summarizeWithLlm`（design.md §4.2）：把指令作为**最后一条
// user 消息**追加到回放前缀之后，这次调用就是上一次请求的真前缀，provider 的
// KV cache 可以复用。

/**
 * 交接单指令：design.md §4.2 的原文，一字不改。
 *
 * 改动它等于改交接单的结构（§6），需要先改设计文档。
 */
export const HANDOFF_INSTRUCTION = `You are a handoff engine. Condense the conversation ABOVE into a handoff document
that lets another model resume the work, and that a human can review later.
Output EXACTLY this Markdown structure, keeping every section (write "(none)" when empty):

# 交接：<阶段名>
## 目标
## 不变式
## 当前状态
## 关键决策
## 死路
## 下一步
## 指针

Preserve exact file paths, commands, error strings, identifiers and numbers.
Do not mention this summary request. Output only the document; do not call tools.`;

/** 一个 message 内容块；只关心 text。 */
export interface HandoffLlmContentBlock {
  readonly type: string;
  readonly text?: string | undefined;
}

/**
 * 一条 provider 形态的消息。只声明本模块用到的 role / content；其它字段
 * （如 `source`）调用方原样传入、这里原样转发，不做校验也不改写形状。
 */
export interface HandoffLlmMessage {
  readonly role: string;
  readonly content: readonly HandoffLlmContentBlock[];
}

/** 流终止原因（`@deepseek-ai/dsh-llm` 的 finish chunk 形状）。 */
export interface HandoffFinishReason {
  readonly kind: string;
  readonly failure?: { readonly message?: string | undefined; readonly code?: string | undefined } | undefined;
}

/** `ctx.llm.stream()` 的原始 chunk；只列 DSH 会产出的 7 种。 */
export type HandoffStreamChunk =
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string | undefined; readonly argumentsDelta: string }
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: HandoffLlmContentBlock }
  | { readonly type: 'usage'; readonly usage: unknown }
  | { readonly type: 'finish'; readonly reason: HandoffFinishReason };

/** `ctx.llm.stream()` 的请求参数（只用到的字段）。 */
export interface HandoffStreamOptions {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly HandoffLlmMessage[];
  readonly toolHistory?: unknown;
  readonly tools?: readonly unknown[];
  /**
   * 输出上限：请求头 `config.maxTokens` 的透传（与压缩后端一致）。
   *
   * **拿不到时整个 key 不出现**：adapter 回落到 `model.maxTokens ?? connection.maxTokens`，
   * 显式传 `undefined` 在语义上等价但没必要依赖那一点。
   */
  readonly maxTokens?: number | undefined;
  readonly sessionId: string;
  readonly purpose: 'compaction';
  readonly signal?: AbortSignal | undefined;
}

/** Host 上下文里本模块用到的部分。 */
export interface HandoffSummarizeContext {
  readonly llm: {
    stream(options: HandoffStreamOptions): AsyncIterable<HandoffStreamChunk>;
  };
}

/** 摘要调用的输入：由调用方（command.ts）准备好的回放前缀。 */
export interface HandoffSummarizeInput {
  /** 回放前缀：system（如有）+ 被遮蔽区域按 surface 顺序派生出的消息。 */
  readonly messages: readonly HandoffLlmMessage[];
  /** 上次请求的 tool 定义（如有）；与 messages 一起构成真前缀。 */
  readonly tools?: readonly unknown[] | undefined;
}

/** Agent 里本模块用到的部分（真实对象远大于它，多出来的字段不关心）。 */
export interface HandoffSummarizeAgent {
  readonly session: {
    readonly id: string;
    requestHeader():
      | {
          readonly config?: {
            readonly provider?: string | undefined;
            readonly model?: string | undefined;
            /** 输出上限；`LlmCallConfig` 的字段，不是所有路由都会带上。 */
            readonly maxTokens?: number | undefined;
          } | undefined;
        }
      | undefined
      | null;
    toolHistory?(): unknown;
  };
  readonly options: {
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
  };
}

/** 摘要结果：交接单正文 + 实际使用的模型（失败时整体抛错，不返回半份）。 */
export interface HandoffSummary {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
}

/** 摘要调用的目标：provider / model 与请求头里的输出上限。 */
interface HandoffTarget {
  readonly provider: string;
  readonly model: string;
  /** `requestHeader().config.maxTokens`；拿不到时字段不出现（不能是 `undefined`）。 */
  readonly maxTokens?: number | undefined;
}

/**
 * 从请求头读输出上限：只在是正整数时才算数（DSH 对 `maxTokens` 的约束同款）。
 * 读不到就返回 `undefined`，调用方据此**省略** `maxTokens` key。
 */
function readMaxTokens(config: { readonly maxTokens?: number | undefined } | undefined): number | undefined {
  const value = config?.maxTokens;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 解析目标模型：先上次请求的 header，再 `agent.options`；`maxTokens` 只来自 header。 */
function resolveTarget(agent: HandoffSummarizeAgent): HandoffTarget {
  const config = agent.session.requestHeader()?.config;
  const maxTokens = readMaxTokens(config);
  if (
    config !== undefined &&
    typeof config.provider === 'string' &&
    config.provider.length > 0 &&
    typeof config.model === 'string' &&
    config.model.length > 0
  ) {
    return { provider: config.provider, model: config.model, ...(maxTokens === undefined ? {} : { maxTokens }) };
  }
  const provider = agent.options.provider;
  const model = agent.options.model;
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
    return { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) };
  }
  throw new Error('no provider/model available for the handoff summary: the session has no routed request header and no agent options');
}

/** 把 chunk 流拼成文本：优先 text-delta，缺失时退回 block-end 的完整块。 */
async function collectText(stream: AsyncIterable<HandoffStreamChunk>): Promise<{ text: string; finish: HandoffFinishReason | undefined }> {
  const texts = new Map<number, string>();
  let finish: HandoffFinishReason | undefined;
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta': {
        texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text);
        break;
      }
      case 'block-end': {
        // 有的适配器只发 block-end；已经收到 delta 的块不要重复拼接。
        if (chunk.block.type === 'text' && (texts.get(chunk.index) ?? '').trim() === '') {
          texts.set(chunk.index, chunk.block.text ?? '');
        }
        break;
      }
      case 'finish': {
        finish = chunk.reason;
        break;
      }
      default: {
        // reasoning / tool-call / usage / block-start 都不进交接单正文。
        break;
      }
    }
  }
  const text = [...texts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value)
    .join('\n\n')
    .trim();
  return { text, finish };
}

/** 把终止原因翻译成 fail-closed 的错误；只有正常结束（stop / 无 finish）返回 null。 */
function finishFailure(finish: HandoffFinishReason | undefined): Error | null {
  if (finish === undefined) return null;
  switch (finish.kind) {
    case 'stop': {
      return null;
    }
    case 'max-tokens': {
      return new Error('handoff summary truncated at the token cap (incomplete handoff document)');
    }
    case 'tool-calls': {
      // 指令要求"不调用工具"；模型仍在调工具说明这份输出不是交接单。
      return new Error('handoff summary ended in a tool call instead of a handoff document');
    }
    case 'error':
    case 'aborted': {
      const message = finish.failure?.message;
      return new Error(typeof message === 'string' && message.length > 0 ? message : `handoff summary stream finished with "${finish.kind}"`);
    }
    default: {
      return new Error(`handoff summary stream finished with an unknown reason "${finish.kind}"`);
    }
  }
}

/**
 * 生成交接单：回放前缀 + 最后一条 user 指令 → `ctx.llm.stream` → 文本。
 *
 * 空文本、异常终止、被取消都抛错（fail closed）：调用方据此不写备份、不 append。
 *
 * @param ctx - 提供 `llm.stream` 的宿主上下文。
 * @param input - 回放前缀 messages（可含 tools）。
 * @param agent - 提供目标模型、session id 与 tool history 的 agent。
 * @param signal - 可选取消信号；取消同样以抛错表现。
 * @returns 交接单正文与实际使用的 provider/model。
 */
export async function summarizeForHandoff(
  ctx: HandoffSummarizeContext,
  input: HandoffSummarizeInput,
  agent: HandoffSummarizeAgent,
  signal?: AbortSignal,
): Promise<HandoffSummary> {
  const target = resolveTarget(agent);
  const instruction: HandoffLlmMessage = {
    role: 'user',
    content: [{ type: 'text', text: HANDOFF_INSTRUCTION }],
  };
  // 指令必须是最后一条；前缀保持原顺序、原对象。
  const messages: HandoffLlmMessage[] = [...input.messages, instruction];
  const toolHistory = agent.session.toolHistory?.();
  const options: HandoffStreamOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...(toolHistory === undefined ? {} : { toolHistory }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    // 与压缩后端一致（`dsh-compaction-basic` 的 summarizeWithLlm 透传 config.maxTokens）：
    // 不透传时 adapter 会用 model/connection 的默认上限（deepseek 默认 256k），
    // 交接单本来就不需要那么长，既慢又贵。
    ...(target.maxTokens === undefined ? {} : { maxTokens: target.maxTokens }),
    sessionId: agent.session.id,
    // V4：复用压缩的 purpose，避免新增枚举成员；在真机上确认没有副作用。
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  };
  const { text, finish } = await collectText(ctx.llm.stream(options));
  const failure = finishFailure(finish);
  if (failure !== null) throw failure;
  if (text.length === 0) throw new Error('handoff summary produced no text content');
  return { text, provider: target.provider, model: target.model };
}
