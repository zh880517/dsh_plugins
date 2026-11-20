// Host 半工具：kinemesh_info / kinemesh_analyze / kinemesh_render。
// 与 aiworkflow 的 AgentTool 形状一致；报错按仓库约定给
// 「错在哪 + 正确姿势 + 当前这一步」三段式（执行类工具的自愈文案）。
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeModelCached, loadModelScene } from './core/analyze-file.js';
import { sceneBoundsHeight } from './core/analyze/scene-info.js';
import { analyzeClip, type MotionDigest } from './core/motion/analyze.js';
import { resolveNormalization } from './core/motion/normalize.js';
import { loadVocab } from './core/motion/vocab.js';
import { getCachedScene } from './core/scene-cache.js';
import { KinemeshError, reasonOf } from './core/errors.js';
import { renderScreenshots, renderLabelScreenshots } from './core/render/screenshot.js';
import {
  checkBonesAgainstSkeleton,
  loadBonesFile,
  type BonesMapping,
} from './core/analyze/bone-map.js';
import {
  buildSkeletonDigest,
  buildSkeletonReport,
  collectSkeletonSet,
  skeletonReportJson,
  type SkeletonDigest,
} from './core/analyze/skeleton-report.js';
import type { CanonicalScene, InfoReport } from './core/types.js';

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

/**
 * 会话模型表记录器（§6.10.1：Agent 工具直调也进表）——DSH 出口由 host 注入，
 * 会话号取工具执行上下文的 exec.agent.id（aiworkflow 同款口径）；CLI / MCP 无会话概念不注入。
 */
export type SessionModelRecorder = (sessionId: string, absPath: string) => void;

function recordSessionModel(record: SessionModelRecorder | undefined, exec: any, absPath: string): void {
  if (record === undefined) return;
  const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id.trim() : '';
  if (sessionId !== '') record(sessionId, absPath);
}

/** 注册 Agent 工具，返回一次性释放句柄；record = 会话模型表记录器（可选，DSH 出口注入） */
export function registerTools(ctx: any, record?: SessionModelRecorder): () => void {
  const disposers = [
    ctx.tools.register(infoTool(record)),
    ctx.tools.register(analyzeTool(record)),
    ctx.tools.register(renderTool(record)),
    ctx.tools.register(skeletonTool(record)),
  ];
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

// ———————— kinemesh_analyze（M6d，设计文档 §6.7 / §6.6.3 / §6.4） ————————

/** 三出口同名同参口径（DSH JSON Schema / CLI flag / MCP zod 各自投影，语义以此接口为准） */
export interface AnalyzeToolParams {
  /** 缺省第一个 clip；'*' 批量分析全部 clips（M6f，§6.7：summary 变 clips[]、文件按 <clip>/ 分桶） */
  clip?: string;
  /** 中间文件输出目录；缺省 <系统临时目录>/kinemesh-analysis/run-<时间戳>-<pid>/ */
  out?: string;
  /** [t0, t1] 秒切片（M6f）：帧号仍按全片口径；t0 < t1 在出口校验，t1 ≤ 时长由 core 校验 */
  range?: [number, number];
  /** 1–60，缺省 15（core 采样层校验） */
  sampleFps?: number;
  /** 'auto'（缺省）或关节 id / 骨骼名清单 */
  joints?: 'auto' | string[];
  /** summary=只出 summary.json；standard=+frames/segments/keyframes/trajectory；full=+全部关节曲线 */
  detail?: 'summary' | 'standard' | 'full';
  /** 指定关节加出 motion-curves/<joint>.csv */
  curvesFor?: string[];
  /** 能量平滑窗口（采样帧），缺省 5 */
  smooth?: number;
  /** bestLoopRange 口径：strict（缺省）| pose-only；verdict 恒 strict */
  loopMode?: 'strict' | 'pose-only';
  /** 身高归一，缺省 height（以场景包围盒高度为 1） */
  normalize?: 'height' | 'none';
  /** 词汇表文件路径；缺省按 §6.6.3 顺序发现（资产同目录 > cwd > builtin） */
  vocab?: string;
  /** 骨架映射文件路径（kinemesh-bones.json，M7 B.5）；缺省按 资产同目录 > cwd 发现；显式路径不存在给三段式 */
  boneMap?: string;
}

/** 批量口径的 summaryDigest（M6f §6.7：digest.clips[] 逐 clip 内联） */
export interface BatchDigest {
  batch: true;
  clips: Array<{ name: string; digest: MotionDigest }>;
}

export interface AnalyzeRunResult {
  ok: true;
  dir: string;
  files: Array<{ name: string; bytes: number; what: string }>;
  /** 单 clip：MotionDigest；clip:"*" 批量：BatchDigest（digest.clips[]，中间文件按 <clip>/ 分桶） */
  summaryDigest: MotionDigest | BatchDigest;
  warnings?: string[];
  /** 仅当输出落在系统临时目录时给出（读不到文件的自愈指引，§6.4） */
  hint?: string;
}

/**
 * 映射文件发现 + 对骨架校验（M7 B.5，analyze 与 skeleton 共用）：
 * boneMap 参数 > 资产同目录 kinemesh-bones.json > cwd > 无；显式路径不存在 → KinemeshError
 * （存在性校验，不再静默成功）；JSON/schema/骨骼名/肢链链不合法 → 三段式 KinemeshError。
 */
async function resolveBonesMapping(
  explicitPath: string | undefined,
  assetDir: string | undefined,
  scene: CanonicalScene,
): Promise<BonesMapping | null> {
  const loaded = await loadBonesFile({ explicitPath, assetDir, cwd: process.cwd() });
  if (loaded === null) return null;
  const { parentOf } = collectSkeletonSet(scene);
  return checkBonesAgainstSkeleton(loaded.data, loaded.source, parentOf);
}

/**
 * 三出口共用的 analyze 执行 runner：加载场景（M6f 起走 path+mtime 进程内缓存）→ 身高归一 →
 * vocab 发现 → 映射文件发现（M7）→ analyzeClip（单 clip 或 '*' 批量）→ 落盘。抛 KinemeshError（无动画 /
 * clip 缺失 / morph-only / 参数越界 / 词表或映射文件非法等），由各出口转成自己的错误口径
 * （tools errorPayload / CLI fail / MCP errorResult）。
 */
export async function runAnalyze(
  data: ArrayBuffer,
  fileName: string,
  params: AnalyzeToolParams,
  context: { assetDir?: string; absPath?: string } = {},
): Promise<AnalyzeRunResult> {
  // 场景缓存（M6f §6.2）：给了绝对路径就走 path+mtime 进程内缓存（rest 姿态由 sample.ts
  // finally 恢复，命中复用安全）；测试直调无 absPath 时保持直载
  const loadedScene = context.absPath
    ? { scene: await getCachedScene(context.absPath, async () => (await loadModelScene(data, fileName)).scene) }
    : await loadModelScene(data, fileName);
  const { scene } = loadedScene;
  const bonesMapping = await resolveBonesMapping(params.boneMap, context.assetDir, scene);
  const normalization = resolveNormalization(params.normalize ?? 'height', sceneBoundsHeight(scene));
  const vocab = await loadVocab({
    explicitPath: params.vocab,
    assetDir: context.assetDir,
    cwd: process.cwd(),
  });
  const analysis = analyzeClip(scene, {
    clipName: params.clip,
    range: params.range,
    sampleFps: params.sampleFps,
    joints: params.joints,
    smooth: params.smooth,
    scale: normalization.scale,
    normalizeMode: normalization.mode,
    normalizeWarnings: normalization.warnings,
    vocabPrefixes: vocab.prefixes,
    detail: params.detail,
    curvesFor: params.curvesFor,
    loopMode: params.loopMode,
    vocab,
    boneMap: bonesMapping,
  });
  const specified = params.out !== undefined && params.out.trim() !== '';
  const dir = specified
    ? path.resolve(expandHome(params.out!.trim()))
    : path.join(tmpdir(), 'kinemesh-analysis', `run-${Date.now()}-${process.pid}`);
  const files: AnalyzeRunResult['files'] = [];
  for (const artifact of analysis.files) {
    const target = path.join(dir, artifact.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.content, 'utf8');
    files.push({ name: artifact.name, bytes: artifact.bytes, what: artifact.what });
  }
  // 批量口径（M6f）：warnings 逐 clip 聚合去重，digest 用 clips[] envelope；单 clip 路径不变
  const batch = analysis.batch === true;
  const warnings = batch
    ? [
        ...new Set(
          (analysis.summary.clips ?? []).flatMap((entry) => [...entry.summary.warnings, ...entry.summary.normalize.warnings]),
        ),
      ]
    : [...new Set([...analysis.summary.warnings, ...analysis.summary.normalize.warnings])];
  // B.7 非 humanoid 映射的泛化通道口径提示由 sample 层产出（info 不经过、analyze 必带），此处不再重复
  return {
    ok: true,
    dir,
    files,
    // 批量时 analysis.digest 运行时就是 BatchDigest envelope（analyze.ts 构造）；静态类型仍是单 clip 口径
    summaryDigest: batch ? (analysis.digest as unknown as BatchDigest) : analysis.digest,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(specified ? {} : { hint: '输出在系统临时目录；若读文件被沙箱拦截，用 out 参数重跑指向工作区' }),
  };
}

/** range 参数投影（M6f）：undefined = 未给；null = 形状/顺序不合法（调用方给三段式）；数组 = 通过 */
function parseRangeArg(value: unknown): [number, number] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 2) return null;
  const t0 = value[0];
  const t1 = value[1];
  if (typeof t0 !== 'number' || typeof t1 !== 'number' || !Number.isFinite(t0) || !Number.isFinite(t1) || t0 >= t1) {
    return null;
  }
  return [t0, t1];
}

function analyzeTool(record?: SessionModelRecorder): AgentTool {
  return {
    name: 'kinemesh_analyze',
    description:
      '对模型文件的动画片段做动作分析（本地只读，不改文件）：headless 采样 + 派生通道，产出中间文件目录' +
      '（motion-summary.json 分段/facts/loopCheck、motion-frames.csv、motion-segments.json、motion-keyframes.json、' +
      'trajectory、指定关节曲线），并返回内联 summaryDigest（分段表 + 全片统计 + loopCheck + keyframeRender 配方）。' +
      'clip="*" 批量分析全部片段（返回 clips[]、中间文件按 <clip>/ 分子目录）；range=[t0,t1] 秒切片（帧号仍按全片口径）。' +
      '数据层工具：一切数值/label/guess/verdict 由它产出，AI 只引用数值做语义推测；' +
      '语义存疑时把 summaryDigest.keyframeRender 配方原样传给 kinemesh_render 出识别用图。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '模型文件路径（绝对路径，或相对当前工作目录；支持 ~ 开头）' },
        clip: { type: 'string', description: '动画片段名或 "*"（批量分析全部 clips，先 kinemesh_info 查）；缺省第一个 clip' },
        out: { type: 'string', description: '中间文件输出目录；缺省系统临时目录 kinemesh-analysis/run-<时间戳>-<pid>/' },
        range: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '[t0, t1] 秒切片（0 ≤ t0 < t1 ≤ 片段时长）；帧号仍按全片口径，结果可直接喂 kinemesh_render',
        },
        sampleFps: { type: 'integer', description: '采样率 1–60，缺省 15' },
        joints: {
          anyOf: [{ type: 'string', enum: ['auto'] }, { type: 'array', items: { type: 'string' } }],
          description: '"auto"（缺省：人形惯例集 / 非人形 Top-15）或关节 id / 骨骼名清单',
        },
        detail: {
          type: 'string',
          enum: ['summary', 'standard', 'full'],
          description: 'summary=只出 summary.json；standard=+frames/segments/keyframes/trajectory；full=+全部关节曲线；缺省 standard',
        },
        curvesFor: { type: 'array', items: { type: 'string' }, description: '指定关节加出 motion-curves/<joint>.csv（规范 id 或骨骼名）' },
        smooth: { type: 'integer', description: '能量平滑窗口（采样帧），缺省 5' },
        loopMode: { type: 'string', enum: ['strict', 'pose-only'], description: 'bestLoopRange 口径：strict（缺省）四分量；pose-only 去掉位移/朝向（root-motion 循环用）' },
        normalize: { type: 'string', enum: ['height', 'none'], description: '身高归一，缺省 height（数值单位为身高倍数）；拿不到身高自动降级 none' },
        vocab: { type: 'string', description: '词汇表文件路径（kinemesh-vocab.json）；缺省按 资产同目录 > 工作区 > builtin 发现' },
        boneMap: { type: 'string', description: '骨架映射文件路径（kinemesh-bones.json）；缺省按 资产同目录 > 工作区 发现；joints=auto 时映射优先于字典查表' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const range = parseRangeArg(args?.range);
      if (range === null) {
        return errorPayload(
          'range 参数不合法：需要 [t0, t1] 秒数字数组且 t0 < t1。',
          '例如 "range": [0.5, 2]；t1 不超过片段时长（先用 kinemesh_info 查 clips[].duration）。',
          '解析 range 参数',
        );
      }
      const given = typeof args?.path === 'string' ? args.path : '';
      const loaded = await readModelFile(given);
      if (!loaded.ok) return loaded.payload;
      const params: AnalyzeToolParams = {
        clip: typeof args?.clip === 'string' && args.clip.trim() !== '' ? args.clip : undefined,
        out: typeof args?.out === 'string' ? args.out : undefined,
        range,
        sampleFps: typeof args?.sampleFps === 'number' ? args.sampleFps : undefined,
        joints:
          args?.joints === 'auto'
            ? 'auto'
            : Array.isArray(args?.joints)
              ? args.joints.filter((item: unknown) => typeof item === 'string')
              : undefined,
        detail: typeof args?.detail === 'string' ? (args.detail as AnalyzeToolParams['detail']) : undefined,
        curvesFor: Array.isArray(args?.curvesFor) ? args.curvesFor.filter((item: unknown) => typeof item === 'string') : undefined,
        smooth: typeof args?.smooth === 'number' ? args.smooth : undefined,
        loopMode: args?.loopMode === 'strict' || args?.loopMode === 'pose-only' ? args.loopMode : undefined,
        normalize: args?.normalize === 'height' || args?.normalize === 'none' ? args.normalize : undefined,
        vocab: typeof args?.vocab === 'string' && args.vocab.trim() !== '' ? expandHome(args.vocab.trim()) : undefined,
        boneMap: typeof args?.boneMap === 'string' && args.boneMap.trim() !== '' ? expandHome(args.boneMap.trim()) : undefined,
      };
      try {
        const result = await runAnalyze(loaded.data, path.basename(loaded.abs), params, {
          assetDir: path.dirname(loaded.abs),
          absPath: loaded.abs,
        });
        recordSessionModel(record, exec, loaded.abs);
        return result;
      } catch (error) {
        if (error instanceof KinemeshError) {
          return errorPayload(error.message, error.guidance, `分析 ${loaded.abs}`);
        }
        return errorPayload(reasonOf(error), '确认模型能被 kinemesh_info 解析后重试；必要时缩小参数范围（降低 sampleFps / 换 clip）。', `分析 ${loaded.abs}`);
      }
    },
  };
}

// ———————— kinemesh_skeleton（M7，设计文档 §7.3 / 附录 B） ————————

/** 三出口同名同参口径（DSH JSON Schema / CLI flag / MCP zod 各自投影，语义以此接口为准） */
export interface SkeletonToolParams {
  /** 中间文件输出目录；缺省 <系统临时目录>/kinemesh-analysis/run-<时间戳>-<pid>/ */
  out?: string;
  /** 标注截图批次：auto（缺省，CORE15 有缺口才出）/ none（只出 report）/ all（全量） */
  shots?: 'auto' | 'none' | 'all';
  /** 骨架映射文件路径（kinemesh-bones.json，B.5）；缺省按 资产同目录 > cwd 发现 */
  boneMap?: string;
}

export interface SkeletonRunResult {
  ok: true;
  dir: string;
  files: Array<{ name: string; bytes: number; what: string }>;
  /** 内联 skeleton digest：convention / 覆盖统计 / 未映射清单 / 批次清单 / shots 截图路径 / 两级指引 facts */
  digest: SkeletonDigest;
  /** 渲染过程警告（页面异常等；shots 降级说明在 digest.shotsWarning） */
  warnings?: string[];
  /** 仅当输出落在系统临时目录时给出（读不到文件的自愈指引，§6.4） */
  hint?: string;
}

/**
 * 三出口共用的 skeleton 执行 runner：加载场景（进程内缓存，与 analyze 同源）→ 映射文件发现与
 * 校验 → skeleton-report（字典查表 + 映射文件叠加 partGuess、convention、覆盖统计、结构统计、
 * B.4 标注截图批次）→ 落盘 skeleton-report.json → shots:auto/all 按批次真实渲染标注截图
 * （labels-<view>-<两位批次>.png 进同一 run 目录；复用 render 截图管线，缺 playwright 时
 * 降级为只出 report + 三段式指引）。抛 KinemeshError（映射文件路径/schema 非法），由各出口
 * 转成自己的错误口径。
 */
export async function runSkeleton(
  data: ArrayBuffer,
  fileName: string,
  params: SkeletonToolParams,
  context: { assetDir?: string; absPath?: string } = {},
): Promise<SkeletonRunResult> {
  const loadedScene = context.absPath
    ? { scene: await getCachedScene(context.absPath, async () => (await loadModelScene(data, fileName)).scene) }
    : await loadModelScene(data, fileName);
  const { scene } = loadedScene;
  const bonesMapping = await resolveBonesMapping(params.boneMap, context.assetDir, scene);
  // B.1 前缀扩展：skeleton 与 analyze 共用 kinemesh-vocab.json 的 prefixes 字段
  // （发现只走 资产同目录 > cwd；§7.3 契约不给 skeleton 单设 vocab 参数）
  const vocab = await loadVocab({
    assetDir: context.assetDir,
    cwd: process.cwd(),
  });
  const report = buildSkeletonReport(scene, {
    fileName,
    mapping: bonesMapping,
    shots: params.shots ?? 'auto',
    extraPrefixes: vocab.prefixes,
  });
  const specified = params.out !== undefined && params.out.trim() !== '';
  const dir = specified
    ? path.resolve(expandHome(params.out!.trim()))
    : path.join(tmpdir(), 'kinemesh-analysis', `run-${Date.now()}-${process.pid}`);
  const content = skeletonReportJson(report);
  const target = path.join(dir, 'skeleton-report.json');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  const files: SkeletonRunResult['files'] = [
    {
      name: 'skeleton-report.json',
      bytes: Buffer.byteLength(content, 'utf8'),
      what: '骨骼清单/convention/映射覆盖/未映射清单/结构统计/标注截图批次/schema 尾注',
    },
  ];
  // ————— B.4 标注截图真实渲染：每批 × front/side，与 report 同目录；缺 playwright 降级只出 report —————
  let shots: string[] = [];
  let shotsWarning: string | undefined;
  let warnings: string[] = [];
  if (report.batches.length > 0) {
    try {
      const rendered = await renderLabelScreenshots({
        data,
        fileName,
        batches: report.batches.map((batch) => ({ batch: batch.batch, bones: batch.bones })),
        views: ['front', 'side'],
        outDir: dir,
      });
      shots = rendered.images;
      warnings = rendered.warnings;
      for (const file of shots) {
        const name = path.basename(file);
        const size = await stat(file);
        files.push({ name, bytes: size.size, what: `B.4 骨骼名标注截图（${name}，front/side × 批次，骨骼名画在关节旁）` });
      }
    } catch (error) {
      // 降级口径与 render 出口一致：不吞 report，给三段式自愈指引（装 playwright 后重跑）
      shotsWarning =
        error instanceof KinemeshError
          ? `${error.message} —— ${error.guidance}`
          : `${reasonOf(error)} —— 确认模型能被 kinemesh_info 解析后重跑。`;
    }
  }
  return {
    ok: true,
    dir,
    files,
    digest: buildSkeletonDigest(report, shots, shotsWarning),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(specified ? {} : { hint: '输出在系统临时目录；若读文件被沙箱拦截，用 out 参数重跑指向工作区' }),
  };
}

function skeletonTool(record?: SessionModelRecorder): AgentTool {
  return {
    name: 'kinemesh_skeleton',
    description:
      '骨架识别与映射（本地只读）：产出 skeleton-report.json（每骨名称/层级/rest 世界坐标/partGuess/置信、' +
      'convention 约定识别、映射覆盖统计、未映射清单、结构统计 limbChains/groundTips/symmetryPairs/maxChainDepth、' +
      '标注截图批次与映射文件 schema 尾注），并返回内联 digest + 两级兜底指引。' +
      'shots:auto（缺省，CORE15 有缺口才出）/ all 直接渲染骨骼名标注截图 labels-<view>-<两位批次>.png' +
      '（front/side × 每批，B.4 stride 分批防叠；缺 playwright 时降级只出 report 并给安装指引）。' +
      '标准命名 rig（Mixamo/Biped/UE/VRM/Rigify）字典查表直达；非标命名回退 AI 流程：读 report → ' +
      '（命名不透明再读标注截图）→ 写 kinemesh-bones.json → 重跑 analyze 即确定性消费。' +
      '工具只做字典查表与约定识别，模糊匹配与几何启发不做。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '模型文件路径（绝对路径，或相对当前工作目录；支持 ~ 开头）' },
        shots: {
          type: 'string',
          enum: ['auto', 'none', 'all'],
          description: '标注截图批次：auto（缺省，CORE15 有缺口才渲染）/ none（只出 report）/ all（全量批次渲染）',
        },
        boneMap: { type: 'string', description: '骨架映射文件路径（kinemesh-bones.json）；缺省按 资产同目录 > 工作区 发现' },
        out: { type: 'string', description: '中间文件输出目录；缺省系统临时目录 kinemesh-analysis/run-<时间戳>-<pid>/' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const given = typeof args?.path === 'string' ? args.path : '';
      const loaded = await readModelFile(given);
      if (!loaded.ok) return loaded.payload;
      const params: SkeletonToolParams = {
        shots: args?.shots === 'auto' || args?.shots === 'none' || args?.shots === 'all' ? args.shots : undefined,
        boneMap: typeof args?.boneMap === 'string' && args.boneMap.trim() !== '' ? expandHome(args.boneMap.trim()) : undefined,
        out: typeof args?.out === 'string' ? args.out : undefined,
      };
      try {
        const result = await runSkeleton(loaded.data, path.basename(loaded.abs), params, {
          assetDir: path.dirname(loaded.abs),
          absPath: loaded.abs,
        });
        recordSessionModel(record, exec, loaded.abs);
        return result;
      } catch (error) {
        if (error instanceof KinemeshError) {
          return errorPayload(error.message, error.guidance, `识别 ${loaded.abs} 的骨架`);
        }
        return errorPayload(reasonOf(error), '确认模型能被 kinemesh_info 解析后重试。', `识别 ${loaded.abs} 的骨架`);
      }
    },
  };
}

function infoTool(record?: SessionModelRecorder): AgentTool {
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
    async execute(args, exec) {
      const given = typeof args?.path === 'string' ? args.path : '';
      const loaded = await readModelFile(given);
      if (!loaded.ok) return loaded.payload;
      try {
        // M6f：info 的场景构造路径（FBX/OBJ 无 fastInfo）走 path+mtime 进程内缓存
        const report = await analyzeModelCached(loaded.abs, loaded.data, path.basename(loaded.abs));
        recordSessionModel(record, exec, loaded.abs);
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

function renderTool(record?: SessionModelRecorder): AgentTool {
  return {
    name: 'kinemesh_render',
    description:
      '按视角 + 帧号渲染模型截图，PNG 落盘后返回绝对路径数组（再用读图工具逐张查看）。' +
      '视角二选一：view（完整球坐标对象）或 viewPreset（front/side/back/three-quarter/orbit8，' +
      'orbit8 = 八方位连拍）；渲染模式 default / wireframe / skeleton / bones-overlay（骨骼可视化是动作分析刚需）。' +
      'boneLabels 在 skeleton / bones-overlay 模式下给截图画骨骼名文字标签（B.4：auto 第 1 批 | 批次号 | all，' +
      '骨架识别读图用）。截屏构图与 DSH「动析」预览面板完全一致。',
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
        boneLabels: {
          anyOf: [
            { type: 'string', enum: ['auto', 'all'] },
            { type: 'integer', minimum: 1 },
          ],
          description:
            '骨骼名文字标注（B.4，与 mode:skeleton / bones-overlay 联用）："auto"（第 1 批）| 批次号（1 起，stride 分批防叠）| ' +
            '"all"（全部骨骼名都画，允许重叠，调试用）',
        },
        width: { type: 'integer', description: '宽度像素，缺省 1280' },
        height: { type: 'integer', description: '高度像素，缺省 720' },
        out: { type: 'string', description: 'PNG 输出目录；缺省系统临时目录' },
      },
      required: ['path', 'frames'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
    timeoutMs: 180_000,
    async execute(args, exec) {
      const frames = Array.isArray(args?.frames) ? args.frames : undefined;
      if (frames === undefined) {
        return errorPayload('缺少 frames 参数。', 'frames 是帧号整数数组，例如 "frames": [0, 15, 30]；静态模型传 [0]。', '渲染截图');
      }
      const given = typeof args?.path === 'string' ? args.path : '';
      const loaded = await readModelFile(given);
      if (!loaded.ok) return loaded.payload;
      // boneLabels：'auto' / 'all' / 批次号整数（1 起）；其余值按未给处理（schema 层已拦）
      const boneLabelsRaw = args?.boneLabels;
      const boneLabels =
        boneLabelsRaw === 'auto' || boneLabelsRaw === 'all'
          ? boneLabelsRaw
          : typeof boneLabelsRaw === 'number' && Number.isInteger(boneLabelsRaw) && boneLabelsRaw >= 1
            ? boneLabelsRaw
            : undefined;
      try {
        const result = await renderScreenshots({
          data: loaded.data,
          fileName: path.basename(loaded.abs),
          viewInput: { view: args?.view, viewPreset: args?.viewPreset, mode: args?.mode, clip: args?.clip },
          frames: frames.map((frame: unknown) => Number(frame)),
          width: typeof args?.width === 'number' ? args.width : undefined,
          height: typeof args?.height === 'number' ? args.height : undefined,
          outDir: typeof args?.out === 'string' && args.out.trim() !== '' ? expandHome(args.out.trim()) : undefined,
          boneLabels,
        });
        recordSessionModel(record, exec, loaded.abs);
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
