// M6 分析编排（design.md §6.2 数据流）：sample → channels → segment → describe → report。
// 本模块是纯逻辑（无 fs / 宿主 API）：产出中间文件内容字符串与 summary 对象；
// 落盘、参数投影、vocab 发现由三出口工具层（M6d）完成。
import type { CanonicalScene } from '../types.js';
import { KinemeshError } from '../errors.js';
import { jointVelocityMatrix, computeChannels, type FrameChannels } from './channels.js';
import { computeLoopCheck, type LoopCheck, type LoopMode } from './loop.js';
import { segmentClip } from './segment.js';
import { sampleClip, type SampleOptions } from './sample.js';
import {
  buildSummary,
  framesCsv,
  jointCurveCsv,
  keyframesFile,
  keyframesJson,
  loopFactSentence,
  pickKeyframes,
  segmentsJson,
  summaryJson,
  trajectoryFile,
  trajectoryJson,
  trajectorySvg,
  type KeyframeEntry,
  type MotionSummary,
} from './report.js';
import type { VocabEntry } from './vocab.js';
import type { BonesMapping } from '../analyze/bone-map.js';

export interface AnalyzeOptions {
  /** 缺省第一个 clip；'*' 批量分析全部 clips（M6f 实装，§6.7 批量语义） */
  clipName?: string | '*';
  /** [t0, t1] 秒切片（M6f §6.7）：采样网格仍按全片 t 轴、帧号不重置；与 clipName:'*' 互斥 */
  range?: [number, number];
  sampleFps?: number;
  joints?: 'auto' | string[];
  /** 能量平滑窗口（采样帧，缺省 5） */
  smooth?: number;
  /** 身高归一分母（analyze 入口由 normalize 决定；缺省 1 = raw） */
  scale?: number;
  normalizeMode?: 'height' | 'none';
  /** 循环区间扫描口径（A.10）：strict（缺省）四分量打分；pose-only 去掉位移/朝向项（root-motion 循环用）。verdict 恒 strict */
  loopMode?: LoopMode;
  /** summary 只出 summary.json；standard 加 frames/segments/keyframes/trajectory；full 再加全部关节曲线（M6d） */
  detail?: 'summary' | 'standard' | 'full';
  /** 指定关节（规范 id 或骨骼名）加出 motion-curves/<joint>.csv；detail=full 时自动全关节（M6d） */
  curvesFor?: string[];
  /** vocab 词条（M6d，§6.6.3）：决策表前按序匹配；summary.vocab 回显 source 与条目数 */
  vocab?: { source: string; entries: VocabEntry[] };
  /** 骨架映射文件（M7 §7.4，B.5 校验产物）：joints=auto 解析链最高优先；summary.boneMap 回显 */
  boneMap?: BonesMapping | null;
}

export interface MotionArtifact {
  name: string;
  content: string;
  bytes: number;
  /** 一句话说明（Agent 用法，进 files[].what） */
  what: string;
}

export interface MotionDigest {
  clip: MotionSummary['clip'];
  clipStats: MotionSummary['clipStats'];
  segments: MotionSummary['segments'];
  loopCheck: LoopCheck | null;
  facts: string[];
  keyframeRender: { frames: number[]; views: string[]; mode: string; altModes: string[] };
  /** '*' 批量口径（M6f §6.7）：digest.clips[] 逐 clip 内联；单 clip 时缺省（向后兼容红线） */
  clips?: Array<{ name: string; digest: MotionDigest }>;
}

export interface MotionAnalysis {
  summary: MotionSummary;
  /** summaryDigest（§6.7）：分段表 + 全片统计 + loopCheck + keyframeRender 配方 */
  digest: MotionDigest;
  files: MotionArtifact[];
  /** '*' 批量分支标记（M6f）：存在即批量口径——summary.clips[] 每份完整 summary（digest 内联）、
   *  digest.clips[] 逐 clip、files[].name 带 `<clip>/` 前缀；单 clip 时缺省（向后兼容红线） */
  batch?: true;
}

export function analyzeClip(scene: CanonicalScene, options: AnalyzeOptions = {}): MotionAnalysis {
  if (options.clipName === '*') return analyzeAllClips(scene, options);
  return analyzeOneClip(scene, options);
}

/** 单 clip 分析（M6d 原路径，结构不变）：sample → channels → segment → describe → report */
function analyzeOneClip(scene: CanonicalScene, options: AnalyzeOptions): MotionAnalysis {
  const sampleOptions: SampleOptions = {
    clipName: options.clipName,
    sampleFps: options.sampleFps,
    joints: options.joints,
    range: options.range,
    boneMap: options.boneMap,
  };
  const sample = sampleClip(scene, sampleOptions);
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1;
  const channels = computeChannels(sample, { scale });
  const { segments, events } = segmentClip(channels, sample, {
    smooth: options.smooth,
    scale,
    vocab: options.vocab?.entries,
  });
  const loopCheck = computeLoopCheck(sample, channels, { scale, loopMode: options.loopMode });
  const keyframes = pickKeyframes(channels, sample, segments, {
    smooth: options.smooth,
    // A.11 优先级 4：bestLoopRange 的 i/j 两帧（loop-seam）
    loopSeamFrames: loopCheck.bestLoopRange
      ? [loopCheck.bestLoopRange.frameStart, loopCheck.bestLoopRange.frameEnd]
      : undefined,
  });
  const normalize = {
    mode: options.normalizeMode ?? (scale === 1 ? 'none' : 'height'),
    scale,
    warnings: [] as string[],
  };
  const summary = buildSummary({
    clipName: sample.clipName,
    duration: sample.duration,
    fps: scene.meta.fps,
    sample,
    channels,
    segments,
    events,
    keyframes,
    normalize,
    warnings: sample.warnings,
    range: sample.range,
    smooth: options.smooth,
    loopCheck,
    loopSentence: `循环 ${loopCheck.verdict}`,
    loopFact: loopFactSentence(loopCheck),
    vocab: options.vocab && { source: options.vocab.source, entries: options.vocab.entries.length },
    boneMap:
      options.boneMap === undefined || options.boneMap === null
        ? undefined
        : { source: options.boneMap.source, archetype: options.boneMap.archetype, mapped: options.boneMap.parts.size },
  });
  const recipe = keyframesFile(keyframes).renderRecipe;
  const digest: MotionDigest = {
    clip: summary.clip,
    clipStats: summary.clipStats,
    segments: summary.segments,
    loopCheck: summary.loopCheck,
    facts: summary.facts,
    keyframeRender: recipe,
  };

  const detail = options.detail ?? 'standard';
  const files: MotionArtifact[] = [
    artifact('motion-summary.json', summaryJson(summary), 'clip 元数据、全片统计、分段清单、关键帧号、facts 中文事实句——第一入口'),
  ];
  if (detail !== 'summary') {
    files.push(
      artifact('motion-frames.csv', framesCsv(channels), '每采样帧一行：查具体帧、趋势叙述'),
      artifact('motion-segments.json', segmentsJson(summary.segments), '每段 frameStart/frameEnd/label/guess/level/features——「FrameX–FrameY 在干嘛」的直接素材'),
      artifact('motion-keyframes.json', keyframesJson(keyframesFile(keyframes)), '代表帧 + 中文 notes + renderRecipe（按配方传给 kinemesh_render）'),
      artifact('motion-trajectory.json', trajectoryJson(trajectoryFile(channels, sample, events)), '归一化平面轨迹点列 + 步点标记'),
      artifact('motion-trajectory.svg', trajectorySvg(channels), '俯视图 SVG：路径 + 起终点 + 按能量着色；图像工具不支持 SVG 时读 json'),
    );
  }
  let curveVelocities: Float64Array | null = null;
  for (const { index, joint } of resolveCurveJoints(sample, options)) {
    const velocities = curveVelocities ?? (curveVelocities = jointVelocityMatrix(sample, scale));
    const fileName = `${sanitizeCurveJoint(joint.id)}.csv`;
    files.push(
      artifact(
        `motion-curves/${fileName}`,
        jointCurveCsv(sample, index, scale, velocities),
        `${joint.id}（${joint.objectName}）通道明细：位置/速度逐帧曲线，单关节深挖`,
      ),
    );
  }
  return { summary, digest, files };
}

/**
 * '*' 批量分析（M6f §6.7）：每个 clip 一份完整 summary + digest 内联，中间文件名加
 * `<clip>/` 前缀（工具层按 files[].name 分桶落 `<dir>/<clip>/` 子目录）。
 * 单 clip 的返回结构不变（向后兼容红线）：批量口径只体现在 batch 标记与 clips[] 字段。
 * 实现：把场景视图收窄成单 clip 再走 analyzeOneClip——未命名 clip / 重名 clip 都按
 * animations 数组序号精确定位，不靠 pickClip 的按名匹配。
 */
function analyzeAllClips(scene: CanonicalScene, options: AnalyzeOptions): MotionAnalysis {
  if (options.range !== undefined) {
    throw new KinemeshError(
      'range 切片与 clip:"*" 批量不能同用：批量按各 clip 全片分析。',
      '切片分析请指定单一 clip（clip 名 + range）；批量分析去掉 range 参数。',
    );
  }
  if (scene.animations.length === 0) {
    // 复用单 clip 的「无动画资产」三段式拒绝，口径完全一致
    analyzeOneClip({ ...scene, animations: [] }, { ...options, clipName: undefined });
  }
  const usedDirs = new Set<string>();
  const perClip = scene.animations.map((clip) => {
    // 场景视图收窄到单 clip（clipName 清空 → pickClip 取视图内唯一 clip），按数组序号精确定位
    const one = analyzeOneClip({ ...scene, animations: [clip] }, { ...options, clipName: undefined });
    return { name: clip.name, dir: uniqueClipDir(clip.name, usedDirs), analysis: one };
  });
  const files = perClip.flatMap(({ dir, analysis }) =>
    analysis.files.map((file) => ({ ...file, name: `${dir}/${file.name}` })),
  );
  const clips = perClip.map(({ name, analysis }) => ({ name, summary: analysis.summary, digest: analysis.digest }));
  const batchSummary = { batch: true, clips } as unknown as MotionSummary;
  const digestClips = perClip.map(({ name, analysis }) => ({ name, digest: analysis.digest }));
  const batchDigest = { batch: true as const, clips: digestClips } as unknown as MotionDigest;
  return { summary: batchSummary, digest: batchDigest, files, batch: true };
}

/** clip 子目录名（§6.7 `<dir>/<clip>/`）：安全化 + 重名去重（追加 -2/-3…），空名回退序号 */
function uniqueClipDir(name: string, used: Set<string>): string {
  const safe = name.replace(/[^\w.-]+/g, '_');
  let candidate = safe === '' ? 'clip' : safe;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${safe === '' ? 'clip' : safe}-${suffix}`;
  used.add(candidate);
  return candidate;
}

/** 曲线关节解析（§6.4）：detail=full 出全部关节；curvesFor 指定的按 id/骨骼名解析，找不到给自愈指引 */
function resolveCurveJoints(
  sample: { joints: Array<{ id: string; objectName: string }> },
  options: AnalyzeOptions,
): Array<{ index: number; joint: { id: string; objectName: string } }> {
  const wanted = new Map<number, { index: number; joint: { id: string; objectName: string } }>();
  if (options.detail === 'full') {
    sample.joints.forEach((joint, index) => wanted.set(index, { index, joint }));
  }
  const requested = options.curvesFor ?? [];
  if (requested.length === 0) return [...wanted.values()];
  const byKey = new Map<string, number>();
  sample.joints.forEach((joint, index) => {
    byKey.set(joint.id.toLowerCase(), index);
    byKey.set(joint.objectName.toLowerCase(), index);
  });
  const missing: string[] = [];
  for (const entry of requested) {
    const key = entry.trim().toLowerCase();
    if (key === '') continue;
    const index = byKey.get(key);
    if (index === undefined) {
      missing.push(entry);
      continue;
    }
    const joint = sample.joints[index]!;
    wanted.set(index, { index, joint });
  }
  if (missing.length > 0) {
    const available = sample.joints.map((joint) => `${joint.id}（${joint.objectName}）`).join('、');
    throw new KinemeshError(
      `找不到曲线关节：${missing.join('、')}。`,
      `curvesFor 用关节规范 id 或场景骨骼名（先 kinemesh_info 查 bones）；本 clip 可用关节：${available}。`,
    );
  }
  return [...wanted.values()];
}

/** 曲线文件名安全化（骨骼名可能带路径/非法字符；规范 id 本身合法） */
function sanitizeCurveJoint(id: string): string {
  const safe = id.replace(/[^\w.-]+/g, '_');
  return safe === '' ? 'joint' : safe;
}

function artifact(name: string, content: string, what: string): MotionArtifact {
  return { name, content, bytes: Buffer.byteLength(content, 'utf8'), what };
}

export type { FrameChannels, KeyframeEntry, MotionSummary };
