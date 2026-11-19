// M6 分析编排（design.md §6.2 数据流）：sample → channels → segment → describe → report。
// 本模块是纯逻辑（无 fs / 宿主 API）：产出中间文件内容字符串与 summary 对象；
// 落盘、参数投影、vocab 发现由三出口工具层（M6d）完成。
import type { CanonicalScene } from '../types.js';
import { computeChannels, type FrameChannels } from './channels.js';
import { computeLoopCheck, type LoopCheck, type LoopMode } from './loop.js';
import { segmentClip } from './segment.js';
import { sampleClip, type SampleOptions } from './sample.js';
import {
  buildSummary,
  framesCsv,
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

export interface AnalyzeOptions {
  /** 缺省第一个 clip；'*' 批量在工具层展开（M6d） */
  clipName?: string;
  sampleFps?: number;
  joints?: 'auto' | string[];
  /** 能量平滑窗口（采样帧，缺省 5） */
  smooth?: number;
  /** 身高归一分母（analyze 入口由 normalize 决定；缺省 1 = raw） */
  scale?: number;
  normalizeMode?: 'height' | 'none';
  /** 循环区间扫描口径（A.10）：strict（缺省）四分量打分；pose-only 去掉位移/朝向项（root-motion 循环用）。verdict 恒 strict */
  loopMode?: LoopMode;
  /** summary 只出 summary.json；standard 加 frames/segments/keyframes/trajectory；full 再加关节曲线（M6d） */
  detail?: 'summary' | 'standard' | 'full';
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
}

export interface MotionAnalysis {
  summary: MotionSummary;
  /** summaryDigest（§6.7）：分段表 + 全片统计 + loopCheck + keyframeRender 配方 */
  digest: MotionDigest;
  files: MotionArtifact[];
}

export function analyzeClip(scene: CanonicalScene, options: AnalyzeOptions = {}): MotionAnalysis {
  const sampleOptions: SampleOptions = {
    clipName: options.clipName,
    sampleFps: options.sampleFps,
    joints: options.joints,
  };
  const sample = sampleClip(scene, sampleOptions);
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1;
  const channels = computeChannels(sample, { scale });
  const { segments, events } = segmentClip(channels, sample, { smooth: options.smooth, scale });
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
    smooth: options.smooth,
    loopCheck,
    loopSentence: `循环 ${loopCheck.verdict}`,
    loopFact: loopFactSentence(loopCheck),
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
  return { summary, digest, files };
}

function artifact(name: string, content: string, what: string): MotionArtifact {
  return { name, content, bytes: Buffer.byteLength(content, 'utf8'), what };
}

export type { FrameChannels, KeyframeEntry, MotionSummary };
