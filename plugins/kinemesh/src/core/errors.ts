// 带自愈指引的领域错误：message 是「错在哪」，guidance 是「正确姿势」。
// 工具层（tools.ts）在返回给 Agent 前补第三段「当前这一步」。
export class KinemeshError extends Error {
  readonly guidance: string;

  constructor(message: string, guidance: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = 'KinemeshError';
    this.guidance = guidance;
  }

  /** 「错在哪 + 正确姿势」两段；执行类工具由调用方追加「当前这一步」 */
  helpText(): string {
    return `错在哪：${this.message}\n正确姿势：${this.guidance}`;
  }
}

/** reason 的一句话提取（Error / string / unknown 都兜住） */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
