// Host 半工具：kinemesh_info / kinemesh_render。
// 与 aiworkflow 的 AgentTool 形状一致；报错按仓库约定给
// 「错在哪 + 正确姿势 + 当前这一步」三段式（执行类工具的自愈文案）。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { analyzeModel } from './core/analyze-file.js';
import { KinemeshError, reasonOf } from './core/errors.js';
import { renderScreenshots } from './core/render/screenshot.js';
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
  const disposers = [ctx.tools.register(infoTool()), ctx.tools.register(renderTool())];
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // 重复释放忽略
      }
    }
  };
}

/** 读模型文件为 ArrayBuffer（两个工具共用）；失败返回三段式 payload */
type LoadedModel = { ok: true; data: ArrayBuffer; abs: string } | { ok: false; payload: Record<string, unknown> };

async function readModelFile(rawPath: string): Promise<LoadedModel> {
  if (rawPath.trim() === '') {
    return { ok: false, payload: errorPayload('缺少 path 参数。', '传入模型文件路径，例如 {"path": "D:/assets/hero.fbx"}。', '读取模型') };
  }
  const abs = path.resolve(expandHome(rawPath.trim()));
  try {
    const buffer = await readFile(abs);
    const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    return { ok: true, data, abs };
  } catch (error) {
    return {
      ok: false,
      payload: errorPayload(
        reasonOf(error),
        '确认路径存在且可读（Windows 路径用正斜杠或双反斜杠），必要时换绝对路径重试。',
        `读取 ${abs}`,
      ),
    };
  }
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
      const given = typeof args?.path === 'string' ? args.path : '';
      const loaded = await readModelFile(given);
      if (!loaded.ok) return loaded.payload;
      try {
        const report = await analyzeModel(loaded.data, path.basename(loaded.abs));
        return { ok: true, ...report };
      } catch (error) {
        if (error instanceof KinemeshError) {
          return errorPayload(error.message, error.guidance, `读取 ${loaded.abs} 的模型信息`);
        }
        return errorPayload(reasonOf(error), '确认文件是完整的模型文件后重试。', `读取 ${loaded.abs} 的模型信息`);
      }
    },
  };
}

function renderTool(): AgentTool {
  return {
    name: 'kinemesh_render',
    description:
      '按视角 + 帧号渲染模型截图，PNG 落盘后返回绝对路径数组（再用读图工具逐张查看）。' +
      '视角二选一：view（完整球坐标对象）或 viewPreset（front/side/back/three-quarter/orbit8，' +
      'orbit8 = 八方位连拍）；渲染模式 default / wireframe / skeleton / bones-overlay（骨骼可视化是动作分析刚需）。' +
      '截屏构图与 DSH「动析」预览面板完全一致。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '模型文件路径（绝对路径，或相对当前工作目录；支持 ~ 开头）' },
        clip: { type: 'string', description: '动画片段名（先 kinemesh_info 查）；静态模型省略' },
        frames: {
          type: 'array',
          items: { type: 'integer' },
          description: '要渲染的帧号（非负整数，按 30fps 换算 time=frame/30）；动作分析建议关键帧 3～9 帧，一次最多 64',
        },
        view: {
          type: 'object',
          description: '完整视角对象 {"camera":{"azimuth":45,"elevation":15,"distance":3.2,"target":[0,1,0],"fov":40}}；与 viewPreset 二选一，省略字段按场景包围盒缺省',
          additionalProperties: true,
        },
        viewPreset: { type: 'string', description: 'front / side / back / three-quarter / orbit8；与 view 二选一' },
        mode: { type: 'string', description: 'default / wireframe / skeleton / bones-overlay，缺省 default' },
        width: { type: 'integer', description: '宽度像素，缺省 1280' },
        height: { type: 'integer', description: '高度像素，缺省 720' },
        out: { type: 'string', description: 'PNG 输出目录；缺省系统临时目录' },
      },
      required: ['path', 'frames'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
    timeoutMs: 180_000,
    async execute(args) {
      const frames = Array.isArray(args?.frames) ? args.frames : undefined;
      if (frames === undefined) {
        return errorPayload('缺少 frames 参数。', 'frames 是帧号整数数组，例如 "frames": [0, 15, 30]；静态模型传 [0]。', '渲染截图');
      }
      const given = typeof args?.path === 'string' ? args.path : '';
      const loaded = await readModelFile(given);
      if (!loaded.ok) return loaded.payload;
      try {
        const result = await renderScreenshots({
          data: loaded.data,
          fileName: path.basename(loaded.abs),
          viewInput: { view: args?.view, viewPreset: args?.viewPreset, mode: args?.mode, clip: args?.clip },
          frames: frames.map((frame: unknown) => Number(frame)),
          width: typeof args?.width === 'number' ? args.width : undefined,
          height: typeof args?.height === 'number' ? args.height : undefined,
          outDir: typeof args?.out === 'string' && args.out.trim() !== '' ? expandHome(args.out.trim()) : undefined,
        });
        return {
          ok: true,
          images: result.images,
          count: result.images.length,
          warnings: result.warnings,
          hint: 'PNG 已落盘，用读图工具逐张查看后再给结论。',
        };
      } catch (error) {
        if (error instanceof KinemeshError) {
          return errorPayload(error.message, error.guidance, `渲染 ${loaded.abs} 的截图`);
        }
        return errorPayload(reasonOf(error), '缩小 frames 数量或降低分辨率后重试；确认模型能被 kinemesh_info 解析。', `渲染 ${loaded.abs} 的截图`);
      }
    },
  };
}

export type { InfoReport };
