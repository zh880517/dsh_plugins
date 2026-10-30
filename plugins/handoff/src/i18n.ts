// 插件运行时文案：命名空间 `handoff`，中文 + 英文，语言切换后立即生效。
//
// **只覆盖插件自己产生的 UI 文案。** Host 返回的交接结果与失败原因（`/handoff` 的
// CommandResult、`GET /handoff/draft` 的 `error.message`）都是中文，直接展示，不在这里
// 二次翻译 —— 否则英文界面下会出现“Host 中文 + 插件英文”混排。
//
// 注册方式照 aiworkflow 的成熟写法：同一条文案注册到 en / zh / zh-CN / zh-Hans，
// 重复注册（HMR、重复 apply）容错忽略；缺键时退回中文而不是把 key 甩给用户。

export const NS = 'handoff';

export interface Translate {
  (key: string): string;
}

const ZH: Record<string, string> = {
  'button.label': '交接',
  'button.tooltip': '交接',
  'panel.title': '会话交接',
  'panel.subtitle': '把这段对话压成一份交接单，再决定交给谁',
  'panel.close': '关闭',
  'option.inplace.title': '在当前会话交接',
  'option.inplace.desc': '用交接单替换整个会话后缀，不可撤销（会先落盘备份）',
  'option.new.title': '开启新会话交接',
  'option.new.desc': '把交接单带到新会话继续，旧会话原样保留',
  'status.pending.inplace': '正在生成交接单并替换当前会话…',
  'status.pending.new': '正在生成交接单并开启新会话…',
  'status.done': '交接完成。',
  'status.noHistory': '没有可交接的历史。先在这个会话里聊几轮再试。',
  'error.draft': '读取交接单失败。',
  'error.network': '无法连接 Host 读取交接单。',
  'error.noCwd': '找不到当前会话的工作目录，无法创建新会话。',
  'error.prompt': '新会话已创建，但发送交接单失败。',
  'error.unknownCommand': '交接命令不可用，请确认插件已启用。',
  'error.unknown': '未知错误。',
  'error.emptyDoc': '交接单为空，未创建新会话。',
};

const EN: Record<string, string> = {
  'button.label': 'Handoff',
  'button.tooltip': 'Hand off',
  'panel.title': 'Hand off',
  'panel.subtitle': 'Condense this conversation into a handoff document',
  'panel.close': 'Close',
  'option.inplace.title': 'Hand off in this conversation',
  'option.inplace.desc':
    'Replace the entire conversation suffix with the document. Not reversible; a backup is written first.',
  'option.new.title': 'Hand off to a new conversation',
  'option.new.desc': 'Carry the document into a new conversation; this one stays untouched.',
  'status.pending.inplace': 'Generating the handoff document and replacing this conversation…',
  'status.pending.new': 'Generating the handoff document and opening a new conversation…',
  'status.done': 'Handoff complete.',
  'status.noHistory': 'Nothing to hand off yet. Talk a few more turns in this conversation first.',
  'error.draft': 'Could not read the handoff document.',
  'error.network': 'Could not reach the Host for the handoff document.',
  'error.noCwd': 'The current conversation has no working directory, so a new conversation cannot be created.',
  'error.prompt': 'The new conversation was created, but sending the handoff document failed.',
  'error.unknownCommand': 'The handoff command is unavailable. Check that the plugin is enabled.',
  'error.unknown': 'Unknown error.',
  'error.emptyDoc': 'The handoff document is empty; no new conversation was created.',
};

/** 运行时字典（测试用来断言中英 key 对齐）。 */
export const TEXTS: Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>> = { zh: ZH, en: EN };

/** 注册到客户端 locale 服务；返回释放函数（重复注册的标签直接跳过）。 */
export function registerTexts(ctx: any): () => void {
  const disposers: Array<() => void> = [];
  const packs: Array<[string, Record<string, string>]> = [
    ['en', EN],
    ['zh', ZH],
    ['zh-CN', ZH],
    ['zh-Hans', ZH],
  ];
  for (const [locale, dict] of packs) {
    try {
      const dispose = ctx.locale.register(NS, locale, dict);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch {
      // 已注册或不支持的标签：忽略，其余 locale 继续
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 忽略重复释放
      }
    }
  };
}
