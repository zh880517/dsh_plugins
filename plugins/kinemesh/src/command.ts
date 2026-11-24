// Host 侧 `/kinemesh` 命令（0.6.0 交互重构）：替代原输入框「动析」按钮。
// 用户在对话里输入 `/kinemesh <要求>` 并拖入模型文件 → 命令把「分析这些文件 + 用户要求」
// 注入当前会话 Agent（followup），由 Agent 调 kinemesh_info / kinemesh_analyze 完成分析。
//
// 命令注册用 Host `ctx.commands.register`：definition = { name, description, input:{hint,attachments}, handler }；
// handler 收到 CommandInvocation = { commandId, agent, rawInput, attachments, signal }。
// 附件（FileBlock）= { type:'file', attachment:{ attachmentId, name, bytes } } 不含磁盘路径，
// 因此经 Host `fileUploads.resolve(agent, attachmentId)` 取内容后落临时文件，再把路径交给 Agent。
// 纯逻辑（扩展名判定 / 消息组装 / 路径提取）抽成可测函数，与本模块的运行时注册解耦。
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ensureTempDir, tempRootDir } from './core/temp-dir.js';

/** 命令名（不带斜杠）；DSH 命令名需匹配其 COMMAND_NAME 正则（小写字母开头） */
export const COMMAND_NAME = 'kinemesh';

/** 可分析的模型扩展名（与 core registry 一致） */
export const MODEL_EXTENSIONS = ['.fbx', '.glb', '.gltf', '.obj'] as const;

/** 文件名是否是可分析的模型（大小写不敏感） */
export function isModelFileName(name: string): boolean {
  const lowered = name.toLowerCase();
  return MODEL_EXTENSIONS.some((ext) => lowered.endsWith(ext));
}

/** 从自由文本里提取绝对/相对路径（支持盘符、UNC、~、含空格时用引号包裹），按出现顺序去重 */
export function extractFilePaths(text: string): string[] {
  const hits: Array<{ index: number; value: string }> = [];
  const quoted = /"([^"]+)"|'([^']+)'/g;
  let match = quoted.exec(text);
  while (match !== null) {
    const value = (match[1] ?? match[2] ?? '').trim();
    if (value !== '') hits.push({ index: match.index, value });
    match = quoted.exec(text);
  }
  const bare = /(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^\s"'<>|]+/g;
  let bareMatch = bare.exec(text);
  while (bareMatch !== null) {
    hits.push({ index: bareMatch.index, value: bareMatch[0].trim() });
    bareMatch = bare.exec(text);
  }
  // 按文本出现位置排序，再按值去重（引号内路径已在 bare 里重复命中时只留一次）
  hits.sort((a, b) => a.index - b.index);
  const out: string[] = [];
  for (const hit of hits) {
    if (hit.value !== '' && !out.includes(hit.value)) out.push(hit.value);
  }
  return out;
}

/** 从用户输入里挑出模型路径（其余文本视为「要求」） */
export function splitRequest(text: string): { paths: string[]; request: string } {
  const candidates = extractFilePaths(text);
  const paths = candidates.filter((candidate) => isModelFileName(candidate));
  let request = text;
  for (const candidate of candidates) request = request.split(candidate).join(' ');
  return { paths, request: request.replace(/\s+/g, ' ').trim() };
}

export interface CommandPlan {
  /** 待分析的模型绝对路径 */
  paths: string[];
  /** 交给 Agent 的完整指令文本 */
  message: string;
}

/** 组装注入给 Agent 的指令（中文；只陈述事实与要求，数值由工具产出，不预设结论） */
export function composeCommandMessage(paths: string[], request: string): string {
  const list = paths.map((item) => `- ${item}`).join('\n');
  const ask = request === '' ? '分析这些动画的动作内容、强度、运动方向与是否循环，并给出依据。' : request;
  return [
    '用 kinemesh 工具分析下面这些模型文件（本地只读）：',
    list,
    '',
    `用户要求：${ask}`,
    '',
    '做法：先 kinemesh_info 看片段与骨架；再用 kinemesh_analyze 出中间文件与 summaryDigest（分段/facts/loopCheck/keyframeRender 配方）；',
    '语义存疑时按配方调 kinemesh_render 出关键帧截图，用读图工具逐张查看后带依据下结论。',
    '数值一律引用工具产出，不要自行换算或编造。',
  ].join('\n');
}

/** 附件最小形状（FileBlock.attachment） */
export interface CommandAttachmentRef {
  attachmentId: string;
  name: string;
  bytes: number;
}

/** 从附件列表里挑模型文件（按扩展名），保持原顺序 */
export function selectModelAttachments<T extends { name: string }>(attachments: readonly T[]): T[] {
  return attachments.filter((item) => isModelFileName(item.name));
}

/** 临时落盘目录（0.9.2：与缺省产物同源，落在 <cwd>/.kinemeshtmp/command-attachments，Host 重启可清） */
export function attachmentTempDir(): string {
  return ensureTempDir(path.join(tempRootDir(), 'command-attachments'));
}

/**
 * 把附件内容落成带正确扩展名的临时文件，返回绝对路径。
 * 内容来源（按优先级）：Buffer/TypedArray 字段 → base64/dataUrl 字符串字段 → 已是路径的字符串字段。
 * 取不到内容返回 null（调用方给自愈提示：改用 `/kinemesh <路径>`）。
 */
export function materializeAttachmentContent(
  name: string,
  content: unknown,
): { fileName: string; data: Uint8Array } | null {
  if (content instanceof Uint8Array) return { fileName: name, data: content };
  if (content instanceof ArrayBuffer) return { fileName: name, data: new Uint8Array(content) };
  if (typeof content === 'string') {
    const base64 = content.includes(',') && content.startsWith('data:') ? content.slice(content.indexOf(',') + 1) : content;
    try {
      const data = Buffer.from(base64, 'base64');
      // 排除纯路径字符串被误判为 base64：模型文件头一定是可辨识的
      if (data.byteLength >= 16 && looksLikeModelBytes(data)) return { fileName: name, data };
    } catch {
      // 继续尝试内容字段
    }
    return null;
  }
  if (typeof content === 'object' && content !== null) {
    const record = content as Record<string, unknown>;
    for (const key of ['data', 'bytes', 'buffer', 'content', 'blob', 'value']) {
      if (record[key] !== undefined && record[key] !== content) {
        const nested = materializeAttachmentContent(name, record[key]);
        if (nested !== null) return nested;
      }
    }
  }
  return null;
}

/** 模型文件头嗅探（FBX 二进制/ASCII、glTF JSON、GLB、OBJ）——避免把任意内容当模型落盘 */
export function looksLikeModelBytes(data: Uint8Array): boolean {
  if (data.byteLength >= 4) {
    // FBX 二进制 magic 是 7 字节 'Kaydara'；GLB 是 4 字节 'glTF'
    if (data.byteLength >= 7 && new TextDecoder('latin1').decode(data.subarray(0, 7)) === 'Kaydara') return true;
    if (new TextDecoder('latin1').decode(data.subarray(0, 4)) === 'glTF') return true;
    if (data[0] === 0x7b) return true; // '{' glTF JSON
    if (data[0] === 0x3b) return true; // ';' FBX ASCII 注释头
  }
  // OBJ / ASCII FBX 文本兜底：前 2KB 出现典型关键字
  const head = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(0, 2048));
  return /FBXHeaderExtension\s*:|^\s*(v|vn|vt|f|o|g|usemtl)\s/m.test(head);
}

/** 命令 handler 的可注入副作用（运行时实现；测试可替换） */
export interface CommandDeps {
  /** 按 attachmentId 取附件内容（Host fileUploads.resolve 的封装）；取不到返回 null */
  readAttachment: (agentId: string, attachmentId: string) => Promise<unknown | null>;
  /** 向会话投递一条用户态消息（Host agents.followup 的封装）；返回 false = Agent 不在线 */
  deliver: (agentId: string, text: string) => boolean;
  /** 写文件（测试可注入内存实现） */
  writeAttachment: (fileName: string, data: Uint8Array) => Promise<string>;
  /** 会话模型表记录（预览页签用） */
  record: (sessionId: string, absPath: string) => void;
}

export interface CommandOutcome {
  kind: 'success' | 'error';
  text: string;
}

/**
 * `/kinemesh` 命令主体（纯逻辑 + 注入依赖）：解析用户输入与附件 → 落盘 → 记录会话模型 → 注入 Agent 指令。
 * 失败一律返回 error 文本（DSH 会把它作为 detached result 显示给用户），不抛异常。
 */
export async function runCommand(
  invocation: {
    agentId: string;
    rawInput: string;
    attachments: readonly CommandAttachmentRef[];
  },
  deps: CommandDeps,
): Promise<CommandOutcome> {
  const { paths: typedPaths, request } = splitRequest(invocation.rawInput ?? '');
  const paths: string[] = [];
  for (const candidate of typedPaths) {
    const abs = resolveLocal(candidate);
    paths.push(abs);
  }

  const modelAttachments = selectModelAttachments(invocation.attachments ?? []);
  const unresolved: string[] = [];
  for (const attachment of modelAttachments) {
    const content = await deps.readAttachment(invocation.agentId, attachment.attachmentId).catch(() => null);
    const materialized = content === null ? null : materializeAttachmentContent(attachment.name, content);
    if (materialized === null) {
      unresolved.push(attachment.name);
      continue;
    }
    try {
      const file = await deps.writeAttachment(materialized.fileName, materialized.data);
      paths.push(file);
    } catch {
      unresolved.push(attachment.name);
    }
  }

  const ignored = (invocation.attachments ?? []).filter((item) => !isModelFileName(item.name));

  if (paths.length === 0) {
    const reasons: string[] = [];
    if (unresolved.length > 0) reasons.push(`附件内容读不出来：${unresolved.join('、')}`);
    if (ignored.length > 0) reasons.push(`忽略的非模型附件：${ignored.map((item) => item.name).join('、')}`);
    return {
      kind: 'error',
      text: [
        '没有可分析的模型文件。',
        '用法：/kinemesh 后拖入 .fbx / .glb / .gltf / .obj，或在命令里直接写文件路径，例如 `/kinemesh E:\\art\\hero.fbx 分析攻击强度`。',
        ...(reasons.length > 0 ? ['', ...reasons] : []),
      ].join('\n'),
    };
  }

  for (const file of paths) deps.record(invocation.agentId, file);
  const delivered = deps.deliver(invocation.agentId, composeCommandMessage(paths, request));
  if (!delivered) {
    return {
      kind: 'error',
      text: `已解析 ${paths.length} 个模型，但当前会话 Agent 不在线，指令没有投递出去；文件路径：\n${paths.join('\n')}`,
    };
  }
  const notes: string[] = [];
  if (unresolved.length > 0) notes.push(`附件读不出内容：${unresolved.join('、')}（可改用直接写路径）`);
  if (ignored.length > 0) notes.push(`已忽略非模型附件：${ignored.map((item) => item.name).join('、')}`);
  return {
    kind: 'success',
    text: [`已把分析指令发给会话 Agent（${paths.length} 个模型）：`, ...paths.map((item) => `- ${item}`), ...(notes.length > 0 ? ['', ...notes] : [])].join(
      '\n',
    ),
  };
}

/** 运行时依赖装配（host.ts 注入 ctx）；单测直接调 runCommand + 假 deps */
export function buildCommandDeps(ctx: any, record: (sessionId: string, absPath: string) => void): CommandDeps {
  return {
    async readAttachment(agentId: string, attachmentId: string): Promise<unknown | null> {
      try {
        const agent = ctx?.get?.('agents')?.get?.(agentId);
        const uploads = ctx?.get?.('fileUploads');
        if (agent === undefined || uploads === undefined || typeof uploads.resolve !== 'function') return null;
        const staged = uploads.resolve(agent, attachmentId);
        if (staged === undefined || staged === null) return null;
        // staged = { type:'file', attachment } 形式时取 attachment；否则原样返回
        const value = (staged as { attachment?: unknown }).attachment ?? staged;
        return value;
      } catch {
        return null;
      }
    },
    deliver(agentId: string, text: string): boolean {
      try {
        const agent = ctx?.get?.('agents')?.get?.(agentId) as { followup?: (message: unknown) => void } | undefined;
        if (agent === undefined || typeof agent.followup !== 'function') return false;
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'schedule' },
        });
        return true;
      } catch {
        return false;
      }
    },
    async writeAttachment(fileName: string, data: Uint8Array): Promise<string> {
      const dir = attachmentTempDir();
      await mkdir(dir, { recursive: true });
      const safe = path.basename(fileName).replace(/[^\w.\-]+/g, '_');
      const target = path.join(dir, `${Date.now()}-${process.pid}-${safe}`);
      await writeFile(target, data);
      return target;
    },
    record,
  };
}

/** 注册 `/kinemesh` 命令；ctx.commands 缺失（老宿主）时静默跳过，不影响工具/页签 */
export function registerCommand(ctx: any, record: (sessionId: string, absPath: string) => void): () => void {
  const commands = ctx?.get?.('commands');
  if (commands === undefined || typeof commands.register !== 'function') return () => undefined;
  try {
    const dispose = commands.register({
      name: COMMAND_NAME,
      description: '用 kinemesh 分析拖入/指定的 3D 模型与动画（FBX/GLB/glTF/OBJ）：片段、骨架、动作强度、循环、关键帧截图',
      input: {
        hint: '可写要求，例如「分析攻击强度与是否循环」；模型文件可直接拖入本输入框',
        attachments: true,
      },
      handler: async (invocation: any) => {
        const outcome = await runCommand(
          {
            agentId: typeof invocation?.agent?.id === 'string' ? invocation.agent.id : '',
            rawInput: typeof invocation?.rawInput === 'string' ? invocation.rawInput : '',
            attachments: Array.isArray(invocation?.attachments) ? invocation.attachments : [],
          },
          buildCommandDeps(ctx, record),
        );
        return outcome.kind === 'success' ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text };
      },
    });
    return typeof dispose === 'function' ? dispose : () => undefined;
  } catch {
    // 命令注册失败（宿主版本差异）不阻塞插件其余能力
    return () => undefined;
  }
}

/** ~ / 相对路径解析（与 host.ts resolveLocal 同口径，独立一份避免循环依赖） */
function resolveLocal(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return path.join(homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}
