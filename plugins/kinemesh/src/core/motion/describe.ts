// 阈值→标签（design.md 附录 A.8 决策表 + A.9 强度档位）：label 确定性（idle/contact-move/
// airborne/action），guess 是工具的语义猜测（允许 Agent 基于数值推翻，依据写进 features.basis）。
// 决策表自上而下首条命中；vocab 自定义词条（M6d）按序插在表前，first-match 不变。
import {
  HIPS_LOW_OFFSET,
  RUN_SPEED,
  SPIN_TH,
  STRIKE_DUR,
  STRIKE_PEAK,
  STRIKE_DOMINANCE,
  STRIKE_TURN_NET_MAX,
  SMOOTH_M,
  TURN_TH,
  WALK_SPEED,
  intensityLevel,
  type IntensityLevel,
} from './constants.js';
import {
  jointSpeedMatrix,
  smoothSeries,
  wrapDegrees,
  type FrameChannels,
} from './channels.js';
import type { SampleResult } from './sample.js';
import { matchVocab, type VocabEntry } from './vocab.js';

export interface SegmentRange {
  /** 闭区间：采样帧下标（0..N−1） */
  start: number;
  end: number;
}

export type RelativeLevel = 'rel-low' | 'rel-mid' | 'rel-high';

export interface SegmentFeatures {
  /** 秒 */
  dur: number;
  meanE: number;
  peakE: number;
  /** 段内线速度最高的关节（平手取权重更大者，再取关节序） */
  peakJoint: string;
  peakJointSpeed: number;
  rootDisp: number;
  rootSpeed: number;
  turnNet: number;
  turnTotal: number;
  bodyDir: string;
  airRatio: number;
  hipsLow: boolean;
  /** 段内 hips 峰值升高（max − 段首，H）——A.8 #1「净升」的确定性口径 */
  hipsRise: number;
  /** 段内支撑描述众数（facts 用） */
  support: string;
  /** 段内 moveDir 众数（facts 用） */
  dirMode: string;
  /** guess 依据（中文，随输出回显） */
  basis: string;
}

export interface DescribedSegment extends SegmentRange {
  index: number;
  label: string;
  guess: string;
  level: IntensityLevel;
  relativeLevel: RelativeLevel;
  features: SegmentFeatures;
}

export interface DescribeOptions {
  /** 能量平滑窗口（采样帧，缺省 5 → 半窗 SMOOTH_M） */
  smooth?: number;
  /** 身高归一分母（缺省 1） */
  scale?: number;
  /** vocab 词条（M6d，§6.6.3）：按序插在 A.8 决策表前，首条命中按 action 覆盖 guess（label 不动） */
  vocab?: VocabEntry[];
}

const STRIKE_PUNCH_JOINTS = new Set(['L.Hand', 'R.Hand', 'L.LowerArm', 'R.LowerArm']);
const STRIKE_KICK_JOINTS = new Set([
  'L.Foot',
  'R.Foot',
  'L.LowerLeg',
  'R.LowerLeg',
  'L.Toe',
  'R.Toe',
]);
const PREV_RECOVER_GUESSES = new Set(['strike-punch', 'strike-kick', 'jump', 'spin']);

/** 线性插值分位数（q ∈ [0,1]；升序输入） */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (pos - lo);
}

/** 众数：计数最多者，并列取先达到最大计数的值（按帧序扫描） */
function modeOf(values: string[], skip?: string): string {
  const counts = new Map<string, number>();
  let best = '';
  let bestCount = -1;
  for (const value of values) {
    if (skip !== undefined && value === skip) continue;
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function percentileBasis(value: number): string {
  return value.toFixed(2);
}

export function describeSegments(
  channels: FrameChannels,
  sample: SampleResult,
  ranges: SegmentRange[],
  options: DescribeOptions = {},
): DescribedSegment[] {
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1;
  // 半窗 m 与 segment.ts/report.ts 同式（总审 #2）：只有 smooth 未传时落 SMOOTH_M——
  // smooth:1 → m=0（原始能量口径），不再被 `|| SMOOTH_M` 分叉成 m=2
  const m = options.smooth !== undefined ? Math.max(0, Math.floor(options.smooth / 2)) : SMOOTH_M;
  const eSmoothed = smoothSeries(channels.energy, m);
  const sorted = [...eSmoothed].sort((a, b) => a - b);
  const p50 = quantile(sorted, 0.5);
  const p90 = quantile(sorted, 0.9);
  const speeds = jointSpeedMatrix(sample, scale);
  const jointCount = sample.joints.length;
  const dt = sample.dt;

  // hips 世界 y 序列（H）；无 hips 时 hipsLow/hipsRise 不可用（记 false/0）
  const hipsIndex = sample.anchors.hips;
  const hipsY: number[] | null =
    hipsIndex >= 0
      ? Array.from({ length: sample.frameCount }, (_, k) => sample.positions[(k * jointCount + hipsIndex) * 3 + 1]! / scale)
      : null;
  const hipsP10 = hipsY ? quantile([...hipsY].sort((a, b) => a - b), 0.1) : 0;

  const described: DescribedSegment[] = [];
  let prevGuess = '';
  let prevMeanE = 0;
  ranges.forEach((range, index) => {
    const frames = range.end - range.start + 1;
    const dur = frames * dt;
    let meanSum = 0;
    let peakE = 0;
    for (let k = range.start; k <= range.end; k += 1) {
      const value = eSmoothed[k]!;
      meanSum += value;
      peakE = Math.max(peakE, value);
    }
    const meanE = meanSum / frames;

    // peakJoint：段内帧×关节速度最大者；平手取权重更大者，再取关节序
    let peakJointIndex = 0;
    let peakJointSpeed = -1;
    for (let k = range.start; k <= range.end; k += 1) {
      for (let j = 0; j < jointCount; j += 1) {
        const speed = speeds[k * jointCount + j]!;
        if (speed > peakJointSpeed + 1e-12) {
          peakJointSpeed = speed;
          peakJointIndex = j;
        } else if (Math.abs(speed - peakJointSpeed) <= 1e-12 && sample.joints[j]!.weight > sample.joints[peakJointIndex]!.weight) {
          peakJointIndex = j;
        }
      }
    }
    const peakJoint = sample.joints[peakJointIndex]!;

    const dx = (channels.rootX[range.end] ?? 0) - (channels.rootX[range.start] ?? 0);
    const dz = (channels.rootZ[range.end] ?? 0) - (channels.rootZ[range.start] ?? 0);
    const rootDisp = Math.sqrt(dx * dx + dz * dz);
    const rootSpeed = dur > 0 ? rootDisp / dur : 0;
    const h0 = channels.heading[range.start] ?? 0;
    const h1 = channels.heading[range.end] ?? 0;
    const turnNet = Math.abs(wrapDegrees(h1 - h0));
    const turnTotal = (channels.turnTotal[range.end] ?? 0) - (channels.turnTotal[range.start] ?? 0);

    const bodyDirValues: string[] = [];
    const dirValues: string[] = [];
    const supportValues: string[] = [];
    let airborneFrames = 0;
    for (let k = range.start; k <= range.end; k += 1) {
      const body = channels.moveDirBody[k] ?? 'in-place';
      const dir = channels.moveDir[k] ?? 'in-place';
      if (body !== 'in-place') bodyDirValues.push(body);
      if (dir !== 'in-place') dirValues.push(dir);
      supportValues.push(channels.support[k] ?? 'air');
      if (channels.airborne[k]) airborneFrames += 1;
    }
    const bodyDir = bodyDirValues.length > 0 ? modeOf(bodyDirValues) : 'in-place';
    const dirMode = dirValues.length > 0 ? modeOf(dirValues) : 'in-place';
    const supportMode = supportValues.length > 0 ? modeOf(supportValues) : 'air';
    const airRatio = frames > 0 ? airborneFrames / frames : 0;
    const hipsLow =
      hipsY !== null &&
      Array.from({ length: frames }, (_, i) => hipsY[range.start + i]!).reduce((sum, v) => sum + v, 0) / frames <
        hipsP10 - HIPS_LOW_OFFSET;
    const hipsRise = hipsY
      ? Math.max(...Array.from({ length: frames }, (_, i) => hipsY[range.start + i]!)) - hipsY[range.start]!
      : 0;

    // ———— 决策表（A.8，自上而下首条命中） ————
    let label: string;
    let guess: string;
    let basis: string;
    if (airRatio > 0.5) {
      label = 'airborne';
      if (hipsRise >= 0.05) {
        guess = 'jump';
        basis = `腾空占比 ${percentileBasis(airRatio)}，hips 峰值升高 ${percentileBasis(hipsRise)} 身高`;
      } else {
        guess = 'fall';
        basis = `腾空占比 ${percentileBasis(airRatio)}，hips 未显著升高（${percentileBasis(hipsRise)}）`;
      }
    } else if (
      // A.8 #2（0.5.1 末端主导前置）：带垫步/转体的挥击曾系统性误报 walk/run——
      // 末端速度远超根速度、能量达 high 档（meanE ≥ 0.8，§6.6.2）且是短瞬态（dur ≤ STRIKE_DUR，
      // 不吃收招段）时按 strike 判；高转向段（净转角 ≥ STRIKE_TURN_NET_MAX）豁免走 turn/spin。
      peakJointSpeed >= STRIKE_DOMINANCE * Math.max(rootSpeed, 0.1) &&
      meanE >= 0.8 &&
      dur <= STRIKE_DUR &&
      turnNet < STRIKE_TURN_NET_MAX &&
      STRIKE_PUNCH_JOINTS.has(peakJoint.id)
    ) {
      label = 'action';
      guess = 'strike-punch';
      basis = `末端主导：${peakJoint.id} 峰值 ${percentileBasis(peakJointSpeed)} H/s ≥ ${STRIKE_DOMINANCE}× 根速度（${percentileBasis(rootSpeed)}）`;
    } else if (
      peakJointSpeed >= STRIKE_DOMINANCE * Math.max(rootSpeed, 0.1) &&
      meanE >= 0.8 &&
      dur <= STRIKE_DUR &&
      turnNet < STRIKE_TURN_NET_MAX &&
      STRIKE_KICK_JOINTS.has(peakJoint.id)
    ) {
      label = 'action';
      guess = 'strike-kick';
      basis = `末端主导：${peakJoint.id} 峰值 ${percentileBasis(peakJointSpeed)} H/s ≥ ${STRIKE_DOMINANCE}× 根速度（${percentileBasis(rootSpeed)}）`;
    } else if (rootSpeed >= RUN_SPEED) {
      label = 'contact-move';
      guess = 'run';
      basis = `根速度 ${percentileBasis(rootSpeed)} H/s ≥ ${RUN_SPEED}`;
    } else if (rootSpeed >= WALK_SPEED && bodyDir === 'back') {
      label = 'contact-move';
      guess = 'backpedal';
      basis = `身体相对方向 back 且根速度 ${percentileBasis(rootSpeed)} H/s`;
    } else if (rootSpeed >= WALK_SPEED && (bodyDir === 'left' || bodyDir === 'right')) {
      label = 'contact-move';
      guess = bodyDir === 'left' ? 'strafe-l' : 'strafe-r';
      basis = `身体相对方向 ${bodyDir} 且根速度 ${percentileBasis(rootSpeed)} H/s`;
    } else if (rootSpeed >= WALK_SPEED) {
      label = 'contact-move';
      guess = 'walk';
      basis = `根速度 ${percentileBasis(rootSpeed)} H/s，世界方向 ${dirMode}`;
    } else if (turnTotal >= SPIN_TH) {
      label = 'action';
      guess = 'spin';
      basis = `累计转角 ${turnTotal.toFixed(1)}° ≥ ${SPIN_TH}°`;
    } else if (turnNet >= TURN_TH && rootSpeed < WALK_SPEED) {
      label = 'contact-move';
      guess = 'turn';
      basis = `净转角 ${turnNet.toFixed(1)}° ≥ ${TURN_TH}°`;
    } else if (peakE >= STRIKE_PEAK && dur <= STRIKE_DUR && STRIKE_PUNCH_JOINTS.has(peakJoint.id)) {
      label = 'action';
      guess = 'strike-punch';
      basis = `峰值速度 ${percentileBasis(peakJointSpeed)} H/s 出现在 ${peakJoint.id}`;
    } else if (peakE >= STRIKE_PEAK && dur <= STRIKE_DUR && STRIKE_KICK_JOINTS.has(peakJoint.id)) {
      label = 'action';
      guess = 'strike-kick';
      basis = `峰值速度 ${percentileBasis(peakJointSpeed)} H/s 出现在 ${peakJoint.id}`;
    } else if (hipsLow) {
      label = 'action';
      guess = 'crouch';
      basis = `hips 均值低于全片 P10 − ${HIPS_LOW_OFFSET} 身高`;
    } else if (meanE < 0.05) {
      label = 'idle';
      guess = 'idle';
      basis = `均值能量 ${percentileBasis(meanE)} < 0.05`;
    } else if (PREV_RECOVER_GUESSES.has(prevGuess) && meanE < 0.5 * prevMeanE) {
      label = 'action';
      guess = 'recover';
      basis = `均值 ${percentileBasis(meanE)} < 前段（${prevGuess}）均值 ${percentileBasis(prevMeanE)} 的一半`;
    } else {
      label = 'action';
      guess = 'gesture';
      basis = `无更强特征（均值 ${percentileBasis(meanE)}、峰值 ${percentileBasis(peakE)}）`;
    }

    // ———— vocab 词条（§6.6.3）：等效按序插在决策表前，首条命中按 action 覆盖 guess；label 保持表内判定 ————
    if (options.vocab !== undefined && options.vocab.length > 0) {
      const hit = matchVocab(
        { dur, meanE, peakE, peakJoint: peakJoint.id, rootSpeed, turnNet, turnTotal, bodyDir, airRatio, hipsLow },
        options.vocab,
      );
      if (hit !== null) {
        guess = hit.action === 'suppress' ? 'other' : hit.action === 'demote' ? 'gesture' : hit.term;
        basis = `vocab「${hit.term}」命中（${hit.action}）覆盖 guess；表内原判定：${basis}`;
      }
    }

    const level = intensityLevel(meanE, peakE);
    const relativeLevel: RelativeLevel = meanE < p50 ? 'rel-low' : meanE < p90 ? 'rel-mid' : 'rel-high';

    described.push({
      index,
      start: range.start,
      end: range.end,
      label,
      guess,
      level,
      relativeLevel,
      features: {
        dur,
        meanE,
        peakE,
        peakJoint: peakJoint.id,
        peakJointSpeed,
        rootDisp,
        rootSpeed,
        turnNet,
        turnTotal,
        bodyDir,
        airRatio,
        hipsLow,
        hipsRise,
        support: supportMode,
        dirMode,
        basis,
      },
    });
    prevGuess = guess;
    prevMeanE = meanE;
  });
  return described;
}
