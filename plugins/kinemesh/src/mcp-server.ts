// MCP Server 入口（M5）：stdio 传输，工具与 DSH / CLI 同名同参（设计文档 §5.3）。
// 构建成单文件 ESM（mcp/kinemesh-mcp.js，SDK + core 全内联；node: 内建与 playwright 保持外部依赖）。
// 客户端配置：{ "mcpServers": { "kinemesh": { "command": "node", "args": ["<路径>/mcp/kinemesh-mcp.js"] } } }
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { analyzeModelCached } from './core/analyze-file.js';
import { KinemeshError, reasonOf } from './core/errors.js';
import { renderScreenshots } from './core/render/screenshot.js';
import { runAnalyze, runSkeleton } from './tools.js';
import type { InfoReport } from './core/types.js';

const SERVER_VERSION = '0.5.0';
const MAX_MODEL_BYTES = 512 * 1024 * 1024;

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homedir(), input.slice(2));
  return input;
}

async function readModelFile(rawPath: string): Promise<{ data: ArrayBuffer; abs: string }> {
  if (rawPath.trim() === '') throw new KinemeshError('缺少 path 参数。', '传入模型文件路径，例如 {"path": "D:/assets/hero.fbx"}。');
  const abs = path.resolve(expandHome(rawPath.trim()));
  const info = await stat(abs).catch(() => undefined);
  if (info === undefined || !info.isFile()) throw new KinemeshError(`文件不存在：${abs}`, '确认路径存在且可读（相对路径按 MCP 客户端进程的工作目录解析）。');
  if (info.size > MAX_MODEL_BYTES) {
    throw new KinemeshError(
      `文件 ${(info.size / 1024 / 1024).toFixed(0)} MiB 超过 512 MiB 上限。`,
      '先离线减负（减面 / 清贴图 / 去掉多余动画 take）再分析。',
    );
  }
  const buffer = await readFile(abs);
  return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, abs };
}

/** 统一错误转文本块（isError 标记 + 三段式 JSON），Agent 可读 */
function errorResult(error: unknown, step: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (error instanceof KinemeshError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, what: error.message, guidance: error.guidance, step: `当前这一步：${step}` }, null, 2) }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, what: reasonOf(error), guidance: '缩小参数范围后重试。', step: `当前这一步：${step}` }, null, 2) }],
    isError: true,
  };
}

const server = new McpServer({ name: 'kinemesh', version: SERVER_VERSION });

server.tool(
  'kinemesh_info',
  '读取 3D 模型/动画资源文件的结构信息（本地只读）。' +
    '支持 FBX（ASCII ≥7.0 / 二进制 ≥6400）、glTF / GLB（含 VRM）、OBJ。' +
    '返回动画片段（名称/时长/通道数/根运动）、骨骼（数量/深度/人形）、网格（三角面/顶点/蒙皮比例/材质数）、贴图、包围盒与单位体检。',
  {
    path: z.string().describe('模型文件路径（绝对路径，或相对客户端进程工作目录；支持 ~ 开头）'),
  },
  async ({ path: rawPath }) => {
    try {
      const loaded = await readModelFile(rawPath);
      // M6f：info 的场景构造路径（FBX/OBJ 无 fastInfo）走 path+mtime 进程内缓存
      const report: InfoReport = await analyzeModelCached(loaded.abs, loaded.data, path.basename(loaded.abs));
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...report }, null, 2) }] };
    } catch (error) {
      return errorResult(error, `读取 ${rawPath} 的模型信息`);
    }
  },
);

server.tool(
  'kinemesh_analyze',
  '对模型文件的动画片段做动作分析（本地只读）：产出中间文件目录（summary/frames/segments/keyframes/trajectory/关节曲线），' +
    '并返回内联 summaryDigest（分段表 + 全片统计 + loopCheck + keyframeRender 配方）。' +
    '数据层工具：数值/label/guess/verdict 都由它产出，AI 只引用数值做语义推测；' +
    '语义存疑时把 summaryDigest.keyframeRender 配方原样传给 kinemesh_render 出识别用图。',
  {
    path: z.string().describe('模型文件路径（绝对路径，或相对客户端进程工作目录；支持 ~ 开头）'),
    clip: z.string().optional().describe('动画片段名或 "*"（批量分析全部 clips，先 kinemesh_info 查）；缺省第一个 clip'),
    out: z.string().optional().describe('中间文件输出目录；缺省系统临时目录 kinemesh-analysis/run-<时间戳>-<pid>/'),
    range: z.tuple([z.number(), z.number()]).optional().describe('[t0, t1] 秒切片（0 ≤ t0 < t1 ≤ 片段时长）；帧号仍按全片口径，结果可直接喂 kinemesh_render'),
    sampleFps: z.number().int().optional().describe('采样率 1–60，缺省 15（越界由分析层给三段式自愈指引）'),
    joints: z.union([z.literal('auto'), z.array(z.string())]).optional().describe('"auto"（缺省）或关节 id / 骨骼名清单'),
    detail: z.enum(['summary', 'standard', 'full']).optional().describe('summary=只出 summary.json；standard=+frames/segments/keyframes/trajectory；full=+全部关节曲线；缺省 standard'),
    curvesFor: z.array(z.string()).optional().describe('指定关节加出 motion-curves/<joint>.csv（规范 id 或骨骼名）'),
    smooth: z.number().int().optional().describe('能量平滑窗口（采样帧），缺省 5'),
    loopMode: z.enum(['strict', 'pose-only']).optional().describe('bestLoopRange 口径：strict（缺省）四分量；pose-only 去掉位移/朝向（root-motion 循环用）'),
    normalize: z.enum(['height', 'none']).optional().describe('身高归一，缺省 height（数值单位为身高倍数）'),
    vocab: z.string().optional().describe('词汇表文件路径（kinemesh-vocab.json）；缺省按 资产同目录 > 工作区 > builtin 发现'),
    boneMap: z.string().optional().describe('骨架映射文件路径（kinemesh-bones.json）；缺省按 资产同目录 > 工作区 发现；joints=auto 时映射优先于字典查表'),
  },
  async ({ path: rawPath, clip, out, range, sampleFps, joints, detail, curvesFor, smooth, loopMode, normalize, vocab, boneMap }) => {
    try {
      const loaded = await readModelFile(rawPath);
      const result = await runAnalyze(
        loaded.data,
        path.basename(loaded.abs),
        {
          clip,
          out: out === undefined ? undefined : expandHome(out),
          range,
          sampleFps,
          joints,
          detail,
          curvesFor,
          smooth,
          loopMode,
          normalize,
          vocab: vocab === undefined ? undefined : expandHome(vocab),
          boneMap: boneMap === undefined ? undefined : expandHome(boneMap),
        },
        { assetDir: path.dirname(loaded.abs), absPath: loaded.abs },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return errorResult(error, `分析 ${rawPath}`);
    }
  },
);

server.tool(
  'kinemesh_skeleton',
  '骨架识别与映射（本地只读）：产出 skeleton-report.json（每骨名称/层级/rest 世界坐标/partGuess/置信、convention 约定识别、' +
    '映射覆盖统计、未映射清单、结构统计、标注截图批次配方与映射文件 schema 尾注），返回内联 digest + 两级兜底指引。' +
    '标准命名 rig（Mixamo/Biped/UE/VRM/Rigify）字典查表直达；非标命名回退 AI 流程：读 report →（不透明再按批次清单出标注截图）→ ' +
    '写 kinemesh-bones.json → 重跑 analyze 即确定性消费。工具只做字典查表与约定识别。',
  {
    path: z.string().describe('模型文件路径（绝对路径，或相对客户端进程工作目录；支持 ~ 开头）'),
    shots: z.enum(['auto', 'none', 'all']).optional().describe('标注截图批次：auto（缺省，CORE15 有缺口才出）/ none（只出 report）/ all（强制全量批次）'),
    boneMap: z.string().optional().describe('骨架映射文件路径（kinemesh-bones.json）；缺省按 资产同目录 > 工作区 发现'),
    out: z.string().optional().describe('中间文件输出目录；缺省系统临时目录 kinemesh-analysis/run-<时间戳>-<pid>/'),
  },
  async ({ path: rawPath, shots, boneMap, out }) => {
    try {
      const loaded = await readModelFile(rawPath);
      const result = await runSkeleton(
        loaded.data,
        path.basename(loaded.abs),
        {
          shots,
          boneMap: boneMap === undefined ? undefined : expandHome(boneMap),
          out: out === undefined ? undefined : expandHome(out),
        },
        { assetDir: path.dirname(loaded.abs), absPath: loaded.abs },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return errorResult(error, `识别 ${rawPath} 的骨架`);
    }
  },
);

server.tool(
  'kinemesh_render',
  '按视角 + 帧号渲染模型截图，PNG 落盘返回绝对路径数组（再用读图工具逐张查看）。' +
    '视角二选一：view（完整球坐标对象）或 viewPreset（front/side/back/three-quarter/orbit8）；' +
    '渲染模式 default / wireframe / skeleton / bones-overlay。截屏构图与 DSH「动析」预览面板一致。',
  {
    path: z.string().describe('模型文件路径'),
    clip: z.string().optional().describe('动画片段名（先 kinemesh_info 查）；静态模型省略'),
    frames: z.array(z.number().int().nonnegative()).optional().describe('帧号列表（≤64 个，按 30fps 换算 time=frame/30；必填语义在 handler 校验，缺了给三段式指引）'),
    view: z.record(z.string(), z.unknown()).optional().describe('完整视角对象 {"camera":{"azimuth":45,"elevation":15,"distance":3.2,"target":[0,1,0],"fov":40}}'),
    viewPreset: z.string().optional().describe('front / side / back / three-quarter / orbit8；与 view 二选一'),
    mode: z.string().optional().describe('default / wireframe / skeleton / bones-overlay'),
    width: z.number().int().optional().describe('宽度像素，缺省 1280'),
    height: z.number().int().optional().describe('高度像素，缺省 720'),
    out: z.string().optional().describe('PNG 输出目录；缺省系统临时目录'),
  },
  async ({ path: rawPath, clip, frames, view, viewPreset, mode, width, height, out }) => {
    if (frames === undefined || frames.length === 0) {
      return errorResult(new KinemeshError('frames 为空：至少给一个帧号。', 'frames 是整数数组，例如 "frames": [30]；静态模型传 [0]。'), '渲染截图');
    }
    try {
      const loaded = await readModelFile(rawPath);
      const result = await renderScreenshots({
        data: loaded.data,
        fileName: path.basename(loaded.abs),
        viewInput: { view, viewPreset, mode, clip },
        frames,
        width,
        height,
        outDir: out === undefined ? undefined : expandHome(out),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, images: result.images, count: result.images.length, warnings: result.warnings, hint: '用读图工具逐张查看后再给结论。' }, null, 2) }],
      };
    } catch (error) {
      return errorResult(error, `渲染 ${rawPath} 的截图`);
    }
  },
);

await server.connect(new StdioServerTransport());
