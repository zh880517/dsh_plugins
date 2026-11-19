// 分段（design.md 附录 A.7，六步顺序执行）：
// 1 能量平滑 → 2 局部极小候选（显著性过滤）→ 3 接触/腾空硬边界并入 → 4 短段并入
// → 5 相邻同 label+guess 合并 → 6 段数上限收敛。事件时间轴（≤32 条、同帧合并）随后抽取。
import {
  DIRECTION_STABLE_FRAMES,
  EVENTS_MAX,
  SEG_DELTA,
  SEG_MAX_COUNT,
  SEG_MIN_SECONDS,
  SPIN_TH,
  SMOOTH_M,
} from './constants.js';
import { smoothSeries, type FrameChannels } from './channels.js';
import { describeSegments, type DescribedSegment, type SegmentRange } from './describe.js';
import type { SampleResult } from './sample.js';

export type MotionEventType =
  | 'liftoff'
  | 'touchdown'
  | 'contact-change'
  | 'energy-peak'
  | 'direction-change'
  | 'spin';

export interface MotionEvent {
  /** RENDER_FPS 口径帧号（与 kinemesh_render / frames.csv 同口径） */
  frame: number;
  /** 采样时刻（秒） */
  time: number;
  type: MotionEventType;
  /** 事件详情 tag（side/limb/from/to/guess 等） */
  detail: string;
}

export interface SegmentationResult {
  segments: DescribedSegment[];
  events: MotionEvent[];
}

export interface SegmentOptions {
  /** 能量平滑窗口（采样帧，缺省 5 → 半窗 SMOOTH_M，A.7 第 1 步） */
  smooth?: number;
  /** 身高归一分母（透传给 describe） */
  scale?: number;
}

function meanOf(series: number[], start: number, end: number): number {
  let sum = 0;
  for (let k = start; k <= end; k += 1) sum += series[k]!;
  return sum / (end - start + 1);
}

/** 左侧首个局部极大（向左扫到数值不再增大为止；贴边算极大） */
function firstLocalMaxLeft(series: number[], i: number): number {
  let j = i - 1;
  while (j > 0 && series[j - 1]! > series[j]!) j -= 1;
  return j;
}

function firstLocalMaxRight(series: number[], i: number, n: number): number {
  let j = i + 1;
  while (j < n - 1 && series[j + 1]! > series[j]!) j += 1;
  return j;
}

function flipFrames(flags: boolean[]): number[] {
  const frames: number[] = [];
  for (let k = 1; k < flags.length; k += 1) {
    if (flags[k] !== flags[k - 1]) frames.push(k);
  }
  return frames;
}

/** 第 1–4 步：能量切分 + 硬边界 + 短段并入 */
function cutSegments(channels: FrameChannels, options: SegmentOptions): SegmentRange[] {
  const n = channels.frameCount;
  const m = options.smooth !== undefined ? Math.max(0, Math.floor(options.smooth / 2)) : SMOOTH_M;
  const e = smoothSeries(channels.energy, m);
  const dt = channels.times.length > 1 ? channels.times[1]! - channels.times[0]! : 0;

  // 第 2 步：局部极小候选 + 显著性
  const bounds = new Set<number>([0, n - 1]);
  for (let i = 1; i < n - 1; i += 1) {
    if (!(e[i]! < e[i - 1]! && e[i]! <= e[i + 1]!)) continue;
    const left = firstLocalMaxLeft(e, i);
    const right = firstLocalMaxRight(e, i, n);
    if (Math.min(e[left]!, e[right]!) - e[i]! >= SEG_DELTA) bounds.add(i);
  }
  // 第 3 步：接触状态有效翻转帧、腾空进/出帧
  for (const frame of flipFrames(channels.contactL)) bounds.add(frame);
  for (const frame of flipFrames(channels.contactR)) bounds.add(frame);
  for (const frame of flipFrames(channels.airborne)) bounds.add(frame);

  const sorted = [...bounds].sort((a, b) => a - b);
  let ranges: SegmentRange[] = sorted.slice(0, -1).map((start, i) => ({ start, end: sorted[i + 1]! }));

  // 第 4 步：短段（< 3 帧或 < 0.4s）并入平均 Ê 更接近的相邻段（边界段并入唯一邻居）
  const isShort = (range: SegmentRange): boolean =>
    range.end - range.start + 1 < 3 || (range.end - range.start + 1) * dt < SEG_MIN_SECONDS;
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < ranges.length; i += 1) {
      const range = ranges[i]!;
      if (!isShort(range)) continue;
      const mean = meanOf(e, range.start, range.end);
      const left = i > 0 ? ranges[i - 1]! : null;
      const right = i < ranges.length - 1 ? ranges[i + 1]! : null;
      let target: 'left' | 'right';
      if (left === null) target = 'right';
      else if (right === null) target = 'left';
      else {
        const leftGap = Math.abs(meanOf(e, left.start, left.end) - mean);
        const rightGap = Math.abs(meanOf(e, right.start, right.end) - mean);
        target = leftGap <= rightGap ? 'left' : 'right';
      }
      if (target === 'left') {
        left!.end = range.end;
        ranges.splice(i, 1);
      } else {
        right!.start = range.start;
        ranges.splice(i, 1);
      }
      merged = true;
      break;
    }
  }
  return ranges;
}

/** 第 5/6 步：相邻同 label+guess 合并、段数上限收敛（合并后按合并区间重算特征与标签） */
function convergeSegments(
  channels: FrameChannels,
  sample: SampleResult,
  ranges: SegmentRange[],
  options: SegmentOptions,
): DescribedSegment[] {
  let described = describeSegments(channels, sample, ranges, options);
  // 第 5 步：相邻同 label 且同 guess → 合并（重算特征后标签可能变化，循环到稳定）
  for (;;) {
    let mergedAt = -1;
    for (let i = 0; i < described.length - 1; i += 1) {
      const a = described[i]!;
      const b = described[i + 1]!;
      if (a.label === b.label && a.guess === b.guess) {
        mergedAt = i;
        break;
      }
    }
    if (mergedAt < 0) break;
    const mergedRange = { start: described[mergedAt]!.start, end: described[mergedAt + 1]!.end };
    const ranges2 = ranges
      .filter((_, i) => i !== mergedAt && i !== mergedAt + 1)
      .concat([mergedRange])
      .sort((a, b) => a.start - b.start);
    ranges = ranges2;
    described = describeSegments(channels, sample, ranges, options);
  }
  // 第 6 步：段数 > 24 → 按段平均 Ê 升序逐段并入相邻段
  while (described.length > SEG_MAX_COUNT) {
    let target = 0;
    for (let i = 1; i < described.length; i += 1) {
      if (described[i]!.features.meanE < described[target]!.features.meanE) target = i;
    }
    const mergedRange =
      target === 0
        ? { start: described[0]!.start, end: described[1]!.end }
        : target === described.length - 1
          ? { start: described[target - 1]!.start, end: described[target]!.end }
          : pickCloserNeighbor(described, target);
    const drop = target === 0 ? 0 : target - 1;
    const ranges2 = ranges
      .filter((_, i) => i !== drop && i !== drop + 1)
      .concat([mergedRange])
      .sort((a, b) => a.start - b.start);
    ranges = ranges2;
    described = describeSegments(channels, sample, ranges, options);
  }
  return described;
}

function pickCloserNeighbor(described: DescribedSegment[], target: number): SegmentRange {
  const seg = described[target]!;
  const left = described[target - 1]!;
  const right = described[target + 1]!;
  const leftGap = Math.abs(left.features.meanE - seg.features.meanE);
  const rightGap = Math.abs(right.features.meanE - seg.features.meanE);
  return leftGap <= rightGap
    ? { start: left.start, end: seg.end }
    : { start: seg.start, end: right.end };
}

const EVENT_PRIORITY: MotionEventType[] = [
  'liftoff',
  'touchdown',
  'spin',
  'contact-change',
  'direction-change',
  'energy-peak',
];

/** 事件时间轴（A.7）：全片 ≤ 32 条、同帧合并（按优先级留一条）、按帧序 */
function collectEvents(
  channels: FrameChannels,
  sample: SampleResult,
  described: DescribedSegment[],
  options: SegmentOptions,
): MotionEvent[] {
  const n = channels.frameCount;
  const m = options.smooth !== undefined ? Math.max(0, Math.floor(options.smooth / 2)) : SMOOTH_M;
  const e = smoothSeries(channels.energy, m);
  const events: MotionEvent[] = [];
  const push = (k: number, type: MotionEventType, detail: string): void => {
    events.push({ frame: channels.frames[k] ?? k, time: sample.times[k] ?? 0, type, detail });
  };

  // liftoff / touchdown：腾空进/出帧
  for (let k = 1; k < n; k += 1) {
    if (channels.airborne[k] && !channels.airborne[k - 1]) push(k, 'liftoff', 'airborne 开始');
    if (!channels.airborne[k] && channels.airborne[k - 1]) push(k, 'touchdown', 'airborne 结束');
  }
  // contact-change：每次有效翻转（带 side/limb tag）
  for (const side of ['L', 'R'] as const) {
    const flags = side === 'L' ? channels.contactL : channels.contactR;
    for (let k = 1; k < n; k += 1) {
      if (flags[k] !== flags[k - 1]) {
        push(k, 'contact-change', `side=${side} limb=Foot ${flags[k] ? '接触' : '离地'}`);
      }
    }
  }
  // spin：turnTotal 累计跨越 270° 的首帧
  for (let k = 1; k < n; k += 1) {
    const prev = channels.turnTotal[k - 1] ?? 0;
    const cur = channels.turnTotal[k] ?? 0;
    if (cur >= SPIN_TH && prev < SPIN_TH) {
      push(k, 'spin', `累计转角 ${cur.toFixed(1)}°`);
      break;
    }
  }
  // direction-change：moveDir sector 变化且此后稳定 ≥ 3 帧
  for (let k = 1; k < n; k += 1) {
    const cur = channels.moveDir[k] ?? 'in-place';
    const prev = channels.moveDir[k - 1] ?? 'in-place';
    if (cur === prev) continue;
    if (k + DIRECTION_STABLE_FRAMES - 1 > n - 1) break;
    let stable = true;
    for (let i = 1; i < DIRECTION_STABLE_FRAMES; i += 1) {
      if ((channels.moveDir[k + i] ?? 'in-place') !== cur) {
        stable = false;
        break;
      }
    }
    if (stable) push(k, 'direction-change', `from=${prev} to=${cur}`);
  }
  // energy-peak：每段 Ê 峰值帧（带段 guess）
  for (const segment of described) {
    let peakK = segment.start;
    let peakV = -1;
    for (let k = segment.start; k <= segment.end; k += 1) {
      if (e[k]! > peakV) {
        peakV = e[k]!;
        peakK = k;
      }
    }
    push(peakK, 'energy-peak', `guess=${segment.guess} energy=${peakV.toFixed(3)}`);
  }

  // 同帧合并（按优先级留一条）→ 按帧序 → 截到 32 条
  const byFrame = new Map<number, MotionEvent>();
  for (const event of events) {
    const existing = byFrame.get(event.frame);
    if (!existing) {
      byFrame.set(event.frame, event);
      continue;
    }
    if (EVENT_PRIORITY.indexOf(event.type) < EVENT_PRIORITY.indexOf(existing.type)) {
      byFrame.set(event.frame, event);
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame).slice(0, EVENTS_MAX);
}

/** A.7 全流程：返回最终分段（含 label/guess/level/features）与事件时间轴 */
export function segmentClip(
  channels: FrameChannels,
  sample: SampleResult,
  options: SegmentOptions = {},
): SegmentationResult {
  const ranges = cutSegments(channels, options);
  const segments = convergeSegments(channels, sample, ranges, options);
  const events = collectEvents(channels, sample, segments, options);
  return { segments, events };
}
