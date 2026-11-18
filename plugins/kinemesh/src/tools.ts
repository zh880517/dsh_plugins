// Host 半工具：kinemesh_info（M2 起追加 kinemesh_render）。
// 与 aiworkflow 的 AgentTool 形状一致；报错按仓库约定给
// 「错在哪 + 正确姿势 + 当前这一步」三段式（执行类工具的自愈文案）。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { analyzeModel } from './core/analyze-file.js';
import { KinemeshError, reasonOf } from './core/errors.js';
import type { InfoReport } from './core/types.js';

interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>;
  };
  execute: (args: any, exec: any) => Promise<unknown>;
  timeoutMs?: number;
}

function textResult(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** 预期失败的返回形状：ok:false + 三段式（what/guidance/step） */
function errorPayload(what: string, guidance: string, step: string): Record<string, unknown> {
  return { ok: false, what, guidance, step: `当前这一步：${step}` };
}

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homedir(), input.slice(2));
  return input;
}

/** 注册 Agent 工具，返回一次性释放句柄 */
export function registerTools(ctx: any): () => void {
  const dispose = ctx.tools.register(infoTool());
  return () => {
    try {
      dispose();
    } catch {
      // 重复释放忽略
    }
  };
}

function infoTool(): AgentTool {
  return {
    name: 'kinemesh_info',
    description:
      '读取 3D 模型/动画资源文件的结构信息（本地只读分析，不改文件）。' +
      '支持 FBX（ASCII ≥7.0 / 二进制 ≥6400）、glTF / GLB（含 VRM）、OBJ。' +
      '返回：动画片段（名称/时长/通道数/是否有根运动）、骨骼（数量/最大深度/是否人形，提示可否重定向）、' +
      '网格（三角面/顶点/蒙皮比例/材质数）、贴图清单、包围盒与单位体检（厘米未换算这类坑会标出来）。' +
      '拿到模型文件要回答「有哪些动作、多长、能不能用」时先调它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '模型文件路径（绝对路径，或相对当前工作目录；支持 ~ 开头）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
    timeoutMs: 60_000,
    async execute(args) {
      const given = typeof args?.path === 'string' ? args.path.trim() : '';
      if (given === '') {
        return errorPayload('缺少 path 参数。', '传入模型文件路径，例如 {"path": "D:/assets/hero.fbx"}。', '读取模型信息');
      }
      const abs = path.resolve(expandHome(given));
      try {
        const buffer = await readFile(abs);
        const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
        const report = await analyzeModel(data, path.basename(abs));
        return { ok: true, ...report };
      } catch (error) {
        if (error instanceof KinemeshError) {
          return errorPayload(error.message, error.guidance, `读取 ${abs} 的模型信息`);
        }
        return errorPayload(
          reasonOf(error),
          '确认路径存在且可读（Windows 路径用正斜杠或双反斜杠），必要时换绝对路径重试。',
          `读取 ${abs} 的模型信息`,
        );
      }
    },
  };
}

export type { InfoReport };
