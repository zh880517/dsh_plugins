// 中间文件落盘（design.md §6.4 / 附录 A.11–A.13）：JSON / CSV / SVG 序列化 + summary 组装。
// 数值口径（A.14）：长度/速度 3 位小数、角度 1 位；CSV 布尔 true/false；label 英文、facts 中文。
import {
  CALIB_VERSION,
  CONTACT_HEIGHT,
  CONTACT_VEL,
  DEBOUNCE_FRAMES,
  DIRECTION_STABLE_FRAMES,
  EVENTS_MAX,
  HEADING_TH,
  KEYFRAME_DEDUP,
  KEYFRAME_MAX,
  KEYFRAME_SEGMENT_TOP,
  LEVEL_COLORS,
  LOOP_GRID,
  LOOP_MIN_SECONDS,
  LOOP_PASS,
  LOOP_VERDICT_NOTES,
  POSE_MAX_TH,
  POSE_RMS_TH,
  ROOT_DISP_TH,
  RUN_SPEED,
  SEG_DELTA,
  SEG_MAX_COUNT,
  SEG_MIN_SECONDS,
  SMOOTH_M,
  STRIKE_DUR,
  STRIKE_PEAK,
  SPIN_TH,
  SAMPLE_FPS_DEFAULT,
  SAMPLE_FPS_MAX,
  SAMPLE_FPS_MIN,
  SAMPLE_COUNT_MAX,
  TRAJECTORY_MAX_DOTS,
  TURN_TH,
  VEL_SEAM_TH,
  WALK_SPEED,
  intensityLevel,
  type IntensityLevel,
} from './constants.js';
import { smoothSeries, type FrameChannels } from './channels.js';
import type { MotionDigest } from './analyze.js';
import type { DescribedSegment } from './describe.js';
import type { LoopCheck } from './loop.js';
import type { MotionEvent } from './segment.js';
import { RENDER_FPS } from '../viewstate.js';
import type { SampleResult } from './sample.js';

// ———————— frames.csv（§6.4） ————————

export const FRAMES_CSV_COLUMNS = [
  'frame',
  'time',
  'energy',
  'energyLevel',
  'root_x',
  'root_y',
  'root_z',
  'heading',
  'turnTotal',
  'moveDir',
  'moveDirBody',
  'moveSpeed',
  'contactL',
  'contactR',
  'airborne',
  'support',
  'topJoint',
  'topJointSpeed',
  'amplitude',
] as const;

/** 定长小数；把 "-0.000" 这类负零圆整结果归一成非负（避免 CSV 出现 "-0.0"） */
function fixed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return text.startsWith('-') && Number(text) === 0 ? text.slice(1) : text;
}

/** 长度/速度：3 位小数（A.14） */
export function roundLength(value: number): string {
  return fixed(value, 3);
}

/** 角度：1 位小数（A.14） */
export function roundAngle(value: number): string {
  return fixed(value, 1);
}

/** 每采样帧一行的通道明细（§6.4 motion-frames.csv） */
export function framesCsv(channels: FrameChannels): string {
  const length = (values: number[], k: number): number => values[k] ?? 0;
  const word = (values: string[], k: number): string => values[k] ?? '';
  const flag = (values: boolean[], k: number): boolean => values[k] ?? false;
  const lines: string[] = [FRAMES_CSV_COLUMNS.join(',')];
  for (let k = 0; k < channels.frameCount; k += 1) {
    lines.push(
      [
        String(channels.frames[k] ?? k),
        roundLength(length(channels.times, k)),
        roundLength(length(channels.energy, k)),
        word(channels.energyLevel, k),
        roundLength(length(channels.rootX, k)),
        roundLength(length(channels.rootY, k)),
        roundLength(length(channels.rootZ, k)),
        roundAngle(length(channels.heading, k)),
        roundAngle(length(channels.turnTotal, k)),
        word(channels.moveDir, k),
        word(channels.moveDirBody, k),
        roundLength(length(channels.moveSpeed, k)),
        flag(channels.contactL, k) ? 'true' : 'false',
        flag(channels.contactR, k) ? 'true' : 'false',
        flag(channels.airborne, k) ? 'true' : 'false',
        word(channels.support, k),
        word(channels.topJoint, k),
        roundLength(length(channels.topJointSpeed, k)),
        roundLength(length(channels.amplitude, k)),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ———————— motion-curves/<joint>.csv（§6.4 单关节深挖；M6d curvesFor / detail=full 触发） ————————

/** 单关节通道明细列：位置（H）、速度模与分量（H/s）；数值圆整同 frames.csv（A.14） */
export const JOINT_CURVE_CSV_COLUMNS = [
  'frame',
  'time',
  'pos_x',
  'pos_y',
  'pos_z',
  'speed',
  'vx',
  'vy',
  'vz',
] as const;

/**
 * 指定关节的每采样帧曲线（§6.4 motion-curves/<joint>.csv）。
 * @param samplePositions 已缩放（÷scale）后的关节速度向量矩阵（jointVelocityMatrix 的产物，N×J×3）
 */
export function jointCurveCsv(sample: SampleResult, jointIndex: number, scale: number, velocities: Float64Array): string {
  const jointCount = sample.joints.length;
  const lines: string[] = [JOINT_CURVE_CSV_COLUMNS.join(',')];
  for (let k = 0; k < sample.frameCount; k += 1) {
    const posBase = (k * jointCount + jointIndex) * 3;
    const velBase = posBase;
    const vx = velocities[velBase] ?? 0;
    const vy = velocities[velBase + 1] ?? 0;
    const vz = velocities[velBase + 2] ?? 0;
    lines.push(
      [
        String(sample.frames[k] ?? k),
        roundLength(sample.times[k] ?? 0),
        roundLength((sample.positions[posBase] ?? 0) / scale),
        roundLength((sample.positions[posBase + 1] ?? 0) / scale),
        roundLength((sample.positions[posBase + 2] ?? 0) / scale),
        roundLength(Math.sqrt(vx * vx + vy * vy + vz * vz)),
        roundLength(vx),
        roundLength(vy),
        roundLength(vz),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ———————— 关键帧挑选（A.11） ————————

export interface KeyframeEntry {
  frame: number;
  time: number;
  reason: string;
  note: string;
}

export interface KeyframeOptions {
  smooth?: number;
  /** 循环接缝帧（M6c bestLoopRange 的 i/j，A.11 优先级 4） */
  loopSeamFrames?: number[];
}

/** 优先级列表（cap KEYFRAME_MAX；帧距 < KEYFRAME_DEDUP×30 视为重复，保留优先级高者） */
export function pickKeyframes(
  channels: FrameChannels,
  sample: SampleResult,
  segments: DescribedSegment[],
  options: KeyframeOptions = {},
): KeyframeEntry[] {
  const n = channels.frameCount;
  const m = options.smooth !== undefined ? Math.max(0, Math.floor(options.smooth / 2)) : SMOOTH_M;
  const e = smoothSeries(channels.energy, m);
  const candidates: Array<{ k: number; reason: string; note: string }> = [];

  // 1 全片 Ê 峰值帧
  let globalPeak = 0;
  for (let k = 1; k < n; k += 1) if (e[k]! > e[globalPeak]!) globalPeak = k;
  candidates.push({ k: globalPeak, reason: 'energy-peak', note: '全片能量峰值' });

  // 2 每段 Ê 峰值帧，段按 peakE 降序取前 6
  const topSegments = [...segments].sort((a, b) => b.features.peakE - a.features.peakE).slice(0, KEYFRAME_SEGMENT_TOP);
  for (const segment of topSegments) {
    let peakK = segment.start;
    for (let k = segment.start; k <= segment.end; k += 1) if (e[k]! > e[peakK]!) peakK = k;
    candidates.push({
      k: peakK,
      reason: `segment-peak:${segment.guess}`,
      note: `段 #${segment.index + 1} 峰值（guess ${segment.guess}）`,
    });
  }

  // 3 A 峰值最高 2 帧
  const ampOrder = Array.from({ length: n }, (_, k) => ({ k, amp: channels.amplitude[k] ?? 0 }))
    .sort((a, b) => b.amp - a.amp)
    .slice(0, 2);
  for (const entry of ampOrder) candidates.push({ k: entry.k, reason: 'amplitude-peak', note: '幅度峰值' });

  // 4 bestLoopRange 接缝帧（M6c）
  for (const k of options.loopSeamFrames ?? []) {
    if (k >= 0 && k < n) candidates.push({ k, reason: 'loop-seam', note: '循环接缝帧' });
  }

  // 5 t=0 与 t=duration（端点）
  candidates.push({ k: 0, reason: 'endpoints', note: '起点（t=0）' });
  candidates.push({ k: n - 1, reason: 'endpoints', note: '终点（动作结束）' });

  const dedupFrames = KEYFRAME_DEDUP * RENDER_FPS;
  const kept: Array<{ k: number; reason: string; note: string }> = [];
  for (const candidate of candidates) {
    if (kept.length >= KEYFRAME_MAX) break;
    const duplicate = kept.some((entry) => Math.abs(entry.k - candidate.k) < dedupFrames);
    if (!duplicate) kept.push(candidate);
  }
  return kept.map((entry) => ({
    frame: channels.frames[entry.k] ?? entry.k * RENDER_FPS,
    time: (channels.frames[entry.k] ?? entry.k) / RENDER_FPS,
    reason: entry.reason,
    note: entry.note,
  }));
}

export interface KeyframesFile {
  keyframes: KeyframeEntry[];
  renderRecipe: { frames: number[]; views: string[]; mode: string; altModes: string[] };
}

export function keyframesFile(keyframes: KeyframeEntry[]): KeyframesFile {
  return {
    keyframes,
    renderRecipe: {
      frames: keyframes.map((entry) => entry.frame),
      views: ['front', 'side'],
      mode: 'skeleton',
      altModes: ['bones-overlay'],
    },
  };
}

export function keyframesJson(file: KeyframesFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ———————— trajectory JSON / SVG（A.13） ————————

export interface TrajectoryPoint {
  frame: number;
  x: number;
  z: number;
  energy: number;
}

export interface TrajectoryFile {
  units: string;
  points: TrajectoryPoint[];
  stepMarks: Array<{ frame: number; x: number; z: number; side: string }>;
}

export function trajectoryFile(
  channels: FrameChannels,
  sample: SampleResult,
  events: MotionEvent[],
): TrajectoryFile {
  const points: TrajectoryPoint[] = [];
  for (let k = 0; k < channels.frameCount; k += 1) {
    points.push({
      frame: channels.frames[k] ?? k,
      x: channels.rootX[k] ?? 0,
      z: channels.rootZ[k] ?? 0,
      energy: channels.energy[k] ?? 0,
    });
  }
  // 步点 = touchdown 事件的 root 平面位置
  const stepMarks: TrajectoryFile['stepMarks'] = [];
  for (const event of events) {
    if (event.type !== 'touchdown') continue;
    const k = channels.frames.indexOf(event.frame);
    if (k < 0) continue;
    stepMarks.push({
      frame: event.frame,
      x: channels.rootX[k] ?? 0,
      z: channels.rootZ[k] ?? 0,
      side: event.detail.includes('side=L') ? 'L' : event.detail.includes('side=R') ? 'R' : 'both',
    });
  }
  return { units: '身高 H（rootPos − rootPos(0)）', points, stepMarks };
}

export function trajectoryJson(file: TrajectoryFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A.13：俯视图 SVG（手写轻量 SVG，无栅格化依赖；无文本；单文件 ≤ 32KB） */
export function trajectorySvg(channels: FrameChannels): string {
  const n = channels.frameCount;
  const xs = channels.rootX;
  const zs = channels.rootZ;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < n; k += 1) {
    minX = Math.min(minX, xs[k] ?? 0);
    maxX = Math.max(maxX, xs[k] ?? 0);
    minZ = Math.min(minZ, zs[k] ?? 0);
    maxZ = Math.max(maxZ, zs[k] ?? 0);
  }
  const extent = Math.max(maxX - minX, maxZ - minZ, 1e-6);
  const scale = 400 / extent;
  const cx = (k: number): number => 40 + ((xs[k] ?? 0) - minX) * scale;
  const cy = (k: number): number => 40 + ((zs[k] ?? 0) - minZ) * scale;
  const f = (value: number): string => value.toFixed(2);

  const parts: string[] = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480">'];
  // 浅色网格十字 + 边框
  parts.push('<rect x="40" y="40" width="400" height="400" fill="none" stroke="#e0e0e0"/>');
  parts.push('<line x1="240" y1="40" x2="240" y2="440" stroke="#e0e0e0"/>');
  parts.push('<line x1="40" y1="240" x2="440" y2="240" stroke="#e0e0e0"/>');
  // 路径折线（主题色，不抽稀）
  const path = Array.from({ length: n }, (_, k) => `${f(cx(k))},${f(cy(k))}`).join(' ');
  parts.push(`<polyline points="${path}" fill="none" stroke="#4a90d9" stroke-width="2"/>`);
  // 每采样帧圆点（五档强度色；帧多时按 stride 抽稀到 ≤ 600）
  const stride = Math.max(1, Math.ceil(n / TRAJECTORY_MAX_DOTS));
  for (let k = 0; k < n; k += stride) {
    const level = (channels.energyLevel[k] ?? 'static') as IntensityLevel;
    parts.push(`<circle cx="${f(cx(k))}" cy="${f(cy(k))}" r="2" fill="${LEVEL_COLORS[level]}"/>`);
  }
  // 起点空心圆 / 终点实心方
  parts.push(`<circle cx="${f(cx(0))}" cy="${f(cy(0))}" r="6" fill="#ffffff" stroke="#333333" stroke-width="2"/>`);
  parts.push(`<rect x="${f(cx(n - 1) - 4)}" y="${f(cy(n - 1) - 4)}" width="8" height="8" fill="#333333"/>`);
  // 起点 heading 箭头（长 24px）
  const headingRad = (((channels.heading[0] ?? 0) * Math.PI) / 180);
  const fx = Math.sin(headingRad);
  const fz = Math.cos(headingRad);
  const ax = cx(0);
  const ay = cy(0);
  const tipX = ax + 24 * fx;
  const tipY = ay + 24 * fz;
  const backX = ax + 17 * fx;
  const backY = ay + 17 * fz;
  parts.push(`<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(tipX)}" y2="${f(tipY)}" stroke="#333333" stroke-width="2"/>`);
  parts.push(
    `<polygon points="${f(tipX)},${f(tipY)} ${f(backX + 4 * fz)},${f(backY - 4 * fx)} ${f(backX - 4 * fz)},${f(backY + 4 * fx)}" fill="#333333"/>`,
  );
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

// ———————— summary（§6.4 motion-summary.json） ————————

/** A.12 循环 facts 句：数值按 A.14 圆整（长度/速度 3 位、角度 1 位），阈值全精度在 components */
export function loopFactSentence(check: LoopCheck): string {
  const c = check.components;
  return (
    `循环检测：${check.verdict}——姿势差 ${roundLength(c.poseRMS)}，位置差 ${roundLength(c.rootDisp)}，` +
    `朝向差 ${roundAngle(c.headingDiff)}°，速度差 ${roundLength(c.velSeam)}；${LOOP_VERDICT_NOTES[check.verdict]}`
  );
}

export interface MotionSummary {
  calibVersion: string;
  /** A.15 常数总表回显（可审计） */
  constants: Record<string, number>;
  clip: {
    name: string;
    duration: number;
    sampleFps: number;
    fps: number | null;
    /** 采样帧数 N */
    frameCount: number;
    /** 30fps 口径总帧数 round(duration×30) */
    frames: number;
    /** range 切片标注（M6f §6.7）：实际分析的 [t0, t1] 秒；未切片时缺省。帧号仍按全片口径 */
    range?: [number, number];
  };
  jointBasis: {
    basis: string;
    joints: Array<{ id: string; objectName: string; weight: number }>;
    declaredJoints: string[];
  };
  normalize: { mode: string; scale: number; warnings: string[] };
  clipStats: {
    energy: { mean: number; p50: number; p90: number; max: number };
    level: IntensityLevel;
    mainDir: string;
    rootTotalDisp: number;
    maxRootYGain: number | null;
    airTime: number;
    airborneFrames: number;
  };
  events: MotionEvent[];
  segments: Array<{
    index: number;
    frameStart: number;
    frameEnd: number;
    label: string;
    guess: string;
    level: IntensityLevel;
    relativeLevel: string;
    features: DescribedSegment['features'];
  }>;
  keyframes: KeyframeEntry[];
  loopCheck: LoopCheck | null;
  vocab: { source: string; entries: number };
  facts: string[];
  warnings: string[];
  /**
   * '*' 批量口径（M6f §6.7）：存在时本对象是批量 envelope——每 clip 一份完整 summary + digest 内联；
   * 单 clip 时缺省（向后兼容红线：单 clip 顶层结构与现有测试不变）。
   */
  clips?: Array<{ name: string; summary: MotionSummary; digest: MotionDigest }>;
}

export interface SummaryInput {
  clipName: string;
  duration: number;
  fps: number | null;
  sample: SampleResult;
  channels: FrameChannels;
  segments: DescribedSegment[];
  events: MotionEvent[];
  keyframes: KeyframeEntry[];
  normalize: { mode: string; scale: number; warnings: string[] };
  warnings: string[];
  /** range 切片（M6f）：sample.range 透传，标注进 summary.clip；未切片缺省 */
  range?: [number, number];
  smooth?: number;
  /** 全片 facts 句的循环子句（M6c 传入 `循环 {verdict}`，缺省无循环子句） */
  loopSentence?: string;
  /** 循环 facts 句（M6c loopFactSentence 的产物，缺省不出该句） */
  loopFact?: string;
  loopCheck?: LoopCheck | null;
  vocab?: { source: string; entries: number };
}

export function buildSummary(input: SummaryInput): MotionSummary {
  const { channels, sample, segments } = input;
  const m = input.smooth !== undefined ? Math.max(0, Math.floor(input.smooth / 2)) : SMOOTH_M;
  const e = smoothSeries(channels.energy, m);
  let meanSum = 0;
  let maxE = 0;
  for (const value of e) {
    meanSum += value;
    maxE = Math.max(maxE, value);
  }
  const meanE = e.length > 0 ? meanSum / e.length : 0;
  const sorted = [...e].sort((a, b) => a - b);
  const q = (ratio: number): number => {
    if (sorted.length === 0) return 0;
    const pos = ratio * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  };

  // 全片主方向 = moveSpeed ≥ 0.05 帧的 sector 众数（A.5）
  const dirs: string[] = [];
  for (let k = 0; k < channels.frameCount; k += 1) {
    if ((channels.moveSpeed[k] ?? 0) >= 0.05 && channels.moveDir[k] !== 'in-place') {
      dirs.push(channels.moveDir[k] ?? 'in-place');
    }
  }
  const dirCounts = new Map<string, number>();
  let mainDir = 'in-place';
  let bestCount = 0;
  for (const dir of dirs) {
    const count = (dirCounts.get(dir) ?? 0) + 1;
    dirCounts.set(dir, count);
    if (count > bestCount) {
      mainDir = dir;
      bestCount = count;
    }
  }

  // 总位移 = rootTrack 端点 − 起点的平面距离（H）
  const rootTrack = sample.rootTrack;
  const rootTotalDisp = rootTrack
    ? Math.sqrt(
        (rootTrack.endpointPosition[0]! - rootTrack.positions[0]!) ** 2 +
          (rootTrack.endpointPosition[2]! - rootTrack.positions[2]!) ** 2,
      ) / input.normalize.scale
    : 0;
  const maxRootY = channels.rootY.reduce((max, value, k) => Math.max(max, k === 0 ? 0 : value), 0);
  const airborneFrames = channels.airborne.filter(Boolean).length;
  const airTime = airborneFrames * sample.dt;

  const segmentsOut = segments.map((segment) => ({
    index: segment.index,
    frameStart: channels.frames[segment.start] ?? segment.start,
    frameEnd: channels.frames[segment.end] ?? segment.end,
    label: segment.label,
    guess: segment.guess,
    level: segment.level,
    relativeLevel: segment.relativeLevel,
    features: segment.features,
  }));

  const clipLevel = intensityLevel(meanE, maxE);
  const facts: string[] = segments.map((segment) => {
    const startFrame = channels.frames[segment.start] ?? segment.start;
    const endFrame = channels.frames[segment.end] ?? segment.end;
    return (
      `frame ${startFrame}–${endFrame}：${segment.features.support}，强度 ${segment.level}` +
      `（均值 ${roundLength(segment.features.meanE)}、峰值 ${roundLength(segment.features.peakE)}），` +
      `位移 ${roundLength(segment.features.rootDisp)} 身高，方向 ${segment.features.dirMode}，guess ${segment.guess}`
    );
  });
  if (input.loopFact) facts.push(input.loopFact);
  const frames30 = Math.round(input.duration * RENDER_FPS);
  const clipFact =
    `总时长 ${roundLength(input.duration)}s（${frames30} 帧@30fps），平均强度 ${clipLevel}，主方向 ${mainDir}` +
    (input.loopSentence ? `；${input.loopSentence}` : '');
  facts.push(clipFact);

  return {
    calibVersion: CALIB_VERSION,
    constants: {
      SAMPLE_FPS_DEFAULT,
      SAMPLE_FPS_MIN,
      SAMPLE_FPS_MAX,
      SAMPLE_COUNT_MAX,
      SMOOTH_M,
      CONTACT_HEIGHT,
      CONTACT_VEL,
      DEBOUNCE_FRAMES,
      SEG_DELTA,
      SEG_MIN_SECONDS,
      SEG_MAX_COUNT,
      POSE_RMS_TH,
      POSE_MAX_TH,
      ROOT_DISP_TH,
      HEADING_TH,
      VEL_SEAM_TH,
      LOOP_GRID,
      LOOP_MIN_SECONDS,
      LOOP_PASS,
      STRIKE_PEAK,
      STRIKE_DUR,
      RUN_SPEED,
      WALK_SPEED,
      TURN_TH,
      SPIN_TH,
      KEYFRAME_MAX,
      KEYFRAME_DEDUP,
      EVENTS_MAX,
      DIRECTION_STABLE_FRAMES,
    },
    clip: {
      name: input.clipName,
      duration: input.duration,
      sampleFps: sample.sampleFps,
      fps: input.fps,
      frameCount: sample.frameCount,
      frames: frames30,
      ...(input.range ? { range: input.range } : {}),
    },
    jointBasis: {
      basis: sample.jointBasis,
      joints: sample.joints.map((joint) => ({ id: joint.id, objectName: joint.objectName, weight: joint.weight })),
      declaredJoints: sample.declaredJoints,
    },
    normalize: input.normalize,
    clipStats: {
      energy: { mean: meanE, p50: q(0.5), p90: q(0.9), max: maxE },
      level: clipLevel,
      mainDir,
      rootTotalDisp,
      maxRootYGain: maxRootY >= 0.05 ? maxRootY : null,
      airTime,
      airborneFrames,
    },
    events: input.events,
    segments: segmentsOut,
    keyframes: input.keyframes,
    loopCheck: input.loopCheck ?? null,
    vocab: input.vocab ?? { source: 'builtin', entries: 0 },
    facts,
    warnings: input.warnings,
  };
}

export function summaryJson(summary: MotionSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export function segmentsJson(segments: MotionSummary['segments']): string {
  return `${JSON.stringify({ segments }, null, 2)}\n`;
}
