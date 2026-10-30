// T3 摘要：拼接顺序、目标模型解析、空输出 / 异常终止的 fail-closed。
// 设计文档：docs/plugins/handoff/design.md §4.2（V4）
import { describe, expect, it } from 'vitest';
import {
  HANDOFF_INSTRUCTION,
  summarizeForHandoff,
  type HandoffLlmMessage,
  type HandoffStreamChunk,
  type HandoffStreamOptions,
  type HandoffSummarizeAgent,
} from '../../plugins/handoff/src/summarize.js';

// ---- fixtures ----

/** 回放前缀：system + 一条用户消息。 */
const PREFIX: HandoffLlmMessage[] = [
  { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
  { role: 'user', content: [{ type: 'text', text: '把 T1 做完' }] },
];

interface FakeLlm {
  calls: HandoffStreamOptions[];
  ctx: { llm: { stream(options: HandoffStreamOptions): AsyncIterable<HandoffStreamChunk> } };
}

function fakeLlm(chunks: readonly HandoffStreamChunk[]): FakeLlm {
  const calls: HandoffStreamOptions[] = [];
  return {
    calls,
    ctx: {
      llm: {
        stream(options: HandoffStreamOptions): AsyncIterable<HandoffStreamChunk> {
          calls.push(options);
          return (async function* generate(): AsyncGenerator<HandoffStreamChunk> {
            for (const chunk of chunks) yield chunk;
          })();
        },
      },
    },
  };
}

/** 已路由过请求的 agent：目标模型来自 requestHeader。 */
function routedAgent(): HandoffSummarizeAgent {
  return {
    session: {
      id: 'session-abc',
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
      toolHistory: () => ({ tools: [] }),
    },
    options: { provider: 'fallback-provider', model: 'fallback-model' },
  };
}

/** 还没有 request/header 的 agent：目标模型退回 agent.options。 */
function unroutedAgent(): HandoffSummarizeAgent {
  return {
    session: {
      id: 'session-abc',
      requestHeader: () => undefined,
    },
    options: { provider: 'fallback-provider', model: 'fallback-model' },
  };
}

/** 请求头带输出上限的 agent（真实 `LlmCallConfig` 里有 maxTokens）。 */
function cappedAgent(maxTokens: number): HandoffSummarizeAgent {
  return {
    session: {
      id: 'session-abc',
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat', maxTokens } }),
      toolHistory: () => ({ tools: [] }),
    },
    options: { provider: 'fallback-provider', model: 'fallback-model' },
  };
}

// ---- tests ----

describe('summarizeForHandoff', () => {
  it('拼接顺序：回放前缀在前，指令是最后一条 user 消息', async () => {
    const { ctx, calls } = fakeLlm([{ type: 'text-delta', index: 0, text: '# 交接：T3\n' }]);
    const result = await summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent());

    expect(calls).toHaveLength(1);
    const options = calls[0]!;
    expect(options.messages).toHaveLength(PREFIX.length + 1);
    // 前缀原顺序、原内容，不被改写
    expect(options.messages.slice(0, PREFIX.length)).toEqual(PREFIX);
    expect(PREFIX).toHaveLength(2);
    // 指令是最后一条，且是 user
    const last = options.messages[options.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last).toEqual({ role: 'user', content: [{ type: 'text', text: HANDOFF_INSTRUCTION }] });

    expect(options.purpose).toBe('compaction');
    expect(options.provider).toBe('deepseek');
    expect(options.model).toBe('deepseek-chat');
    expect(options.sessionId).toBe('session-abc');
    expect(options.toolHistory).toEqual({ tools: [] });
    expect(result).toEqual({ text: '# 交接：T3', provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('requestHeader 没有路由配置时退回 agent.options', async () => {
    const { ctx, calls } = fakeLlm([{ type: 'text-delta', index: 0, text: '# 交接' }]);
    const result = await summarizeForHandoff(ctx, { messages: PREFIX }, unroutedAgent());
    expect(calls[0]!.provider).toBe('fallback-provider');
    expect(calls[0]!.model).toBe('fallback-model');
    expect(result.provider).toBe('fallback-provider');
    // 没有请求头就没有输出上限：key 整个不出现
    expect('maxTokens' in calls[0]!).toBe(false);
  });

  it('透传 requestHeader().config.maxTokens 给 stream', async () => {
    const { ctx, calls } = fakeLlm([{ type: 'text-delta', index: 0, text: '# 交接' }]);
    await summarizeForHandoff(ctx, { messages: PREFIX }, cappedAgent(8000));
    expect(calls[0]!.maxTokens).toBe(8000);
  });

  it('requestHeader 没有 maxTokens 时省略这个 key（不传 undefined）', async () => {
    const { ctx, calls } = fakeLlm([{ type: 'text-delta', index: 0, text: '# 交接' }]);
    await summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent());
    // 用 'in' 断言：`maxTokens: undefined` 会让 `??` 回落到默认值的问题被掩盖
    expect('maxTokens' in calls[0]!).toBe(false);
  });

  it('透传 tools 与取消信号', async () => {
    const { ctx, calls } = fakeLlm([{ type: 'text-delta', index: 0, text: '# 交接' }]);
    const controller = new AbortController();
    await summarizeForHandoff(ctx, { messages: PREFIX, tools: [{ name: 'bash' }] }, routedAgent(), controller.signal);
    expect(calls[0]!.tools).toEqual([{ name: 'bash' }]);
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it('多个 text 块按 index 顺序拼接', async () => {
    const { ctx } = fakeLlm([
      { type: 'text-delta', index: 1, text: '第二步' },
      { type: 'text-delta', index: 0, text: '第一步' },
    ]);
    const result = await summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent());
    expect(result.text).toBe('第一步\n\n第二步');
  });

  it('适配器只发 block-end 时也能拼出正文', async () => {
    const { ctx } = fakeLlm([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '# 交接：块' } },
    ]);
    const result = await summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent());
    expect(result.text).toBe('# 交接：块');
  });

  it('空输出抛错（不产生交接单）', async () => {
    const { ctx } = fakeLlm([]);
    await expect(summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent())).rejects.toThrow(
      /no text content/,
    );
  });

  it('只有空白字符也算空输出', async () => {
    const { ctx } = fakeLlm([{ type: 'text-delta', index: 0, text: '  \n\t ' }]);
    await expect(summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent())).rejects.toThrow(
      /no text content/,
    );
  });

  it('流以 error 结束时抛错，不返回半份交接单', async () => {
    const { ctx } = fakeLlm([
      { type: 'text-delta', index: 0, text: '半份' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } },
    ]);
    await expect(summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent())).rejects.toThrow('provider exploded');
  });

  it('被取消（aborted）时抛错', async () => {
    const { ctx } = fakeLlm([
      { type: 'text-delta', index: 0, text: '半份' },
      { type: 'finish', reason: { kind: 'aborted' } },
    ]);
    await expect(summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent())).rejects.toThrow(/aborted/);
  });

  it('max-tokens 截断时抛错（交接单不完整）', async () => {
    const { ctx } = fakeLlm([
      { type: 'text-delta', index: 0, text: '# 交接：截断' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
    await expect(summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent())).rejects.toThrow(/truncated/);
  });

  it('模型改为调用工具（tool-calls）时抛错', async () => {
    const { ctx } = fakeLlm([
      { type: 'text-delta', index: 0, text: '# 交接：半份' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]);
    await expect(summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent())).rejects.toThrow(/tool call/);
  });

  it('正常结束（stop）不抛错', async () => {
    const { ctx } = fakeLlm([
      { type: 'text-delta', index: 0, text: '# 交接：完整' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    await expect(summarizeForHandoff(ctx, { messages: PREFIX }, routedAgent())).resolves.toMatchObject({
      text: '# 交接：完整',
    });
  });
});
