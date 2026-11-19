// 循环 / 归位检测（design.md §6.5 + 附录 A.10）：P(t) 姿势描述子、poseRMS、seam 四分量、
// verdict 四态（§6.5.3）与 bestLoopRange 扫描（归一化 max 打分，不设权重）。
// 采样对齐：seam 末帧一律用 t=duration 精确端点评估（sample.endpointPositions /
// rootTrack.endpoint*，A.0 虚拟点 k=N），不吃采样网格的量化误差；heading 通道只覆盖
// 网格帧，端点朝向用 rootTrack.endpointQuaternion 按 A.4 回退公式求。
// loopMode 只影响 bestLoopRange 打分（pose-only 去掉位移与朝向两项，root-motion 循环用），
// verdict 恒为 strict 口径（A.10）。
import {
  HEADING_TH,
  LOOP_GRID,
  LOOP_MIN_SECONDS,
  LOOP_PASS,
  POSE_MAX_TH,
  POSE_RMS_TH,
  ROOT_DISP_TH,
  VEL_SEAM_TH,
  type LoopVerdict,
} from './constants.js';
import { jointVelocityMatrix, wrapDegrees, type FrameChannels } from './channels.js';
import type { SampleResult } from './sample.js';

/** 循环区间扫描口径（A.10）：strict = 四分量 max（缺省）；pose-only = 只比姿势与速度 */
export type LoopMode = 'strict' | 'pose-only';

export interface LoopJointDiff {
  /** 规范关节 id（sample.joints 同名） */
  id: string;
  /** 该关节的 P(a)、P(b) 欧氏差（H） */
  diff: number;
}

/** components（§6.5.5）：各分量原值 + 通过阈值，随输出回显、可审计（A.15 同源） */
export interface LoopComponents {
  poseRMS: number;
  poseRMSTh: number;
  maxJoint: number;
  maxJointTh: number;
  /** 根平面位移（H） */
  rootDisp: number;
  rootDispTh: number;
  /** wrap 后朝向差（度） */
  headingDiff: number;
  headingDiffTh: number;
  /** 关节平均速度差（H/s） */
  velSeam: number;
  velSeamTh: number;
}

/** 最优循环区间（A.10）：frameStart/frameEnd 为采样帧下标（0..N−1） */
export interface BestLoopRange {
  frameStart: number;
  frameEnd: number;
  score: number;
  components: LoopComponents;
}

/** motion-summary.json 的 loopCheck 块（§6.5.5） */
export interface LoopCheck {
  referenceFrame: 0;
  poseMatch: boolean;
  positionMatch: boolean;
  velocityMatch: boolean;
  components: LoopComponents;
  verdict: LoopVerdict;
  /** top3 最差关节（带差值，指名道姓给动画师反馈） */
  worstJoints: LoopJointDiff[];
  bestLoopRange: BestLoopRange | null;
}

export interface LoopCheckOptions {
  /** 身高归一分母（缺省 1） */
  scale?: number;
  /** 循环区间扫描口径，缺省 strict */
  loopMode?: LoopMode;
}

const DEG2RAD = Math.PI / 180;

/** 端点朝向（度）：heading 通道只覆盖网格帧，端点用 rootTrack.endpointQuaternion 按 A.4 回退公式 */
function endpointHeading(sample: SampleResult): number {
  const q = sample.rootTrack?.endpointQuaternion;
  if (!q) return 0;
  const qx = q[0]!;
  const qy = q[1]!;
  const qz = q[2]!;
  const qw = q[3]!;
  const vx = 2 * (qw * qy + qx * qz);
  const vz = 1 - 2 * (qx * qx + qy * qy);
  return Math.sqrt(vx * vx + vz * vz) > 1e-9 ? (Math.atan2(vx, vz) * 180) / Math.PI : 0;
}

/**
 * P(t) 姿势矩阵（A.10）：(N+1)×J×3，第 N 行是 t=duration 精确端点。每帧
 * 世界关节位置 − pos(hips) → 绕世界 Y 轴旋转 −heading(k)（公式同 A.5）→ /H
 * ——剥离位移与转身，只比姿势本体。无 hips 时参照 rootPos 轨道（A.5 口径），都没有则记 0。
 */
function buildPoses(sample: SampleResult, channels: FrameChannels, scale: number): Float64Array {
  const n = sample.frameCount;
  const jointCount = sample.joints.length;
  const hips = sample.anchors.hips;
  const rootTrack = sample.rootTrack;
  const headingEnd = endpointHeading(sample);
  const poses = new Float64Array((n + 1) * jointCount * 3);
  for (let k = 0; k <= n; k += 1) {
    const endpoint = k === n;
    const src = endpoint ? sample.endpointPositions : sample.positions;
    let refX = 0;
    let refY = 0;
    let refZ = 0;
    if (hips >= 0) {
      const base = endpoint ? hips * 3 : (k * jointCount + hips) * 3;
      refX = src[base]!;
      refY = src[base + 1]!;
      refZ = src[base + 2]!;
    } else if (rootTrack) {
      const r = endpoint ? rootTrack.endpointPosition : rootTrack.positions;
      refX = r[k * 3]!;
      refY = r[k * 3 + 1]!;
      refZ = r[k * 3 + 2]!;
    }
    const theta = -(endpoint ? headingEnd : channels.heading[k] ?? 0) * DEG2RAD;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (let j = 0; j < jointCount; j += 1) {
      const base = endpoint ? j * 3 : (k * jointCount + j) * 3;
      const dx = src[base]! - refX;
      const dy = src[base + 1]! - refY;
      const dz = src[base + 2]! - refZ;
      const out = (k * jointCount + j) * 3;
      poses[out] = (dx * cos - dz * sin) / scale;
      poses[out + 1] = dy / scale;
      poses[out + 2] = (dx * sin + dz * cos) / scale;
    }
  }
  return poses;
}

/**
 * 速度矩阵：(N+1)×J×3，网格帧用 jointVelocityMatrix（A.2 唯一实现）。第 N 行（端点）
 * 用确定性单侧差分 (p_end − p(N−1))/Δt——与首帧 (p(1) − p(0))/Δt 对称：末帧一律以
 * t=duration 精确端点评估（A.10），不用 N−1 处的中央差分口径。
 */
function buildVelocities(sample: SampleResult, scale: number): Float64Array {
  const n = sample.frameCount;
  const jointCount = sample.joints.length;
  const vel = new Float64Array((n + 1) * jointCount * 3);
  vel.set(jointVelocityMatrix(sample, scale));
  const dt = sample.dt;
  for (let j = 0; j < jointCount; j += 1) {
    const prevBase = (n - 1) * jointCount * 3 + j * 3;
    const outBase = (n * jointCount + j) * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const end = sample.endpointPositions[j * 3 + axis]! / scale;
      const prev = sample.positions[prevBase + axis]! / scale;
      vel[outBase + axis] = (end - prev) / dt;
    }
  }
  return vel;
}

interface PoseMetrics {
  rms: number;
  maxJoint: number;
  worstJoints: LoopJointDiff[];
}

/** poseDistance（A.10）：poseRMS + maxJoint + top3 最差关节（并列保持关节序，确定性） */
function poseDistance(poses: Float64Array, rowA: number, rowB: number, sample: SampleResult): PoseMetrics {
  const jointCount = sample.joints.length;
  const baseA = rowA * jointCount * 3;
  const baseB = rowB * jointCount * 3;
  let sumSq = 0;
  let maxJoint = 0;
  const diffs = new Array<number>(jointCount);
  for (let j = 0; j < jointCount; j += 1) {
    const a = baseA + j * 3;
    const b = baseB + j * 3;
    const dx = poses[a]! - poses[b]!;
    const dy = poses[a + 1]! - poses[b + 1]!;
    const dz = poses[a + 2]! - poses[b + 2]!;
    const d2 = dx * dx + dy * dy + dz * dz;
    sumSq += d2;
    const d = Math.sqrt(d2);
    diffs[j] = d;
    if (d > maxJoint) maxJoint = d;
  }
  const top3 = diffs
    .map((diff, j) => ({ diff, j }))
    .sort((x, y) => y.diff - x.diff)
    .slice(0, 3);
  return {
    rms: Math.sqrt(sumSq / jointCount),
    maxJoint,
    worstJoints: top3.map((entry) => ({ id: sample.joints[entry.j]!.id, diff: entry.diff })),
  };
}

/** mean_j |v_j(a) − v_j(b)|（H/s，A.10 velocitySeam：循环有没有顿挫取决于速度连续性） */
function velocitySeam(vel: Float64Array, rowA: number, rowB: number, jointCount: number): number {
  const baseA = rowA * jointCount * 3;
  const baseB = rowB * jointCount * 3;
  let sum = 0;
  for (let j = 0; j < jointCount; j += 1) {
    const a = baseA + j * 3;
    const b = baseB + j * 3;
    const dx = vel[a]! - vel[b]!;
    const dy = vel[a + 1]! - vel[b + 1]!;
    const dz = vel[a + 2]! - vel[b + 2]!;
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return sum / jointCount;
}

/** 根平面位移（H，A.5 rootPos 参照轨道）；rowB = N 表示 t=duration 端点；无轨道记 0 */
function rootDispBetween(sample: SampleResult, scale: number, rowA: number, rowB: number): number {
  const track = sample.rootTrack;
  if (!track) return 0;
  const x = (row: number): number =>
    row === sample.frameCount ? track.endpointPosition[0]! : track.positions[row * 3]!;
  const z = (row: number): number =>
    row === sample.frameCount ? track.endpointPosition[2]! : track.positions[row * 3 + 2]!;
  const dx = x(rowA) - x(rowB);
  const dz = z(rowA) - z(rowB);
  return Math.sqrt(dx * dx + dz * dz) / scale;
}

function componentsOf(pose: PoseMetrics, rootDisp: number, headingDiff: number, velSeam: number): LoopComponents {
  return {
    poseRMS: pose.rms,
    poseRMSTh: POSE_RMS_TH,
    maxJoint: pose.maxJoint,
    maxJointTh: POSE_MAX_TH,
    rootDisp,
    rootDispTh: ROOT_DISP_TH,
    headingDiff,
    headingDiffTh: HEADING_TH,
    velSeam,
    velSeamTh: VEL_SEAM_TH,
  };
}

/** §6.5.3 verdict 四态：¬pose → no-return；pose ∧ ¬position → return-only；velocity 分 perfect/pose-only */
function verdictOf(poseMatch: boolean, positionMatch: boolean, velocityMatch: boolean): LoopVerdict {
  if (!poseMatch) return 'no-return';
  if (!positionMatch) return 'return-only';
  return velocityMatch ? 'loop-perfect' : 'loop-pose-only';
}

/** 扫描网格（A.10）：N ≤ LOOP_GRID 用全网格，否则等距子网格（含 0 与 N−1） */
function scanGrid(n: number): number[] {
  if (n <= LOOP_GRID) return Array.from({ length: n }, (_, k) => k);
  return Array.from({ length: LOOP_GRID }, (_, idx) => Math.round((idx * (n - 1)) / (LOOP_GRID - 1)));
}

/** 归一化 max 打分（A.10，不设权重）；pose-only 去掉 rootDisp 与 heading 两项 */
function loopScore(
  poseRMS: number,
  rootDisp: number,
  headingDiffAbs: number,
  velSeam: number,
  mode: LoopMode,
): number {
  const poseTerm = poseRMS / POSE_RMS_TH;
  const velTerm = velSeam / VEL_SEAM_TH;
  if (mode === 'pose-only') return Math.max(poseTerm, velTerm);
  return Math.max(poseTerm, rootDisp / ROOT_DISP_TH, headingDiffAbs / HEADING_TH, velTerm);
}

function scanBestLoopRange(
  sample: SampleResult,
  channels: FrameChannels,
  poses: Float64Array,
  vel: Float64Array,
  scale: number,
  mode: LoopMode,
): BestLoopRange | null {
  const jointCount = sample.joints.length;
  const grid = scanGrid(sample.frameCount);
  let best: { rowA: number; rowB: number; score: number; components: LoopComponents } | null = null;
  for (let a = 0; a < grid.length; a += 1) {
    for (let b = a + 1; b < grid.length; b += 1) {
      const rowA = grid[a]!;
      const rowB = grid[b]!;
      if ((rowB - rowA) * sample.dt < LOOP_MIN_SECONDS) continue;
      const pose = poseDistance(poses, rowA, rowB, sample);
      const rootDisp = rootDispBetween(sample, scale, rowA, rowB);
      const headingDiff = wrapDegrees((channels.heading[rowB] ?? 0) - (channels.heading[rowA] ?? 0));
      const velSeam = velocitySeam(vel, rowA, rowB, jointCount);
      const score = loopScore(pose.rms, rootDisp, Math.abs(headingDiff), velSeam, mode);
      // 并列保持先遇到的（i 升序、j 升序扫描，确定性）
      if (best === null || score < best.score) {
        best = { rowA, rowB, score, components: componentsOf(pose, rootDisp, headingDiff, velSeam) };
      }
    }
  }
  if (best === null || best.score >= LOOP_PASS) return null;
  return { frameStart: best.rowA, frameEnd: best.rowB, score: best.score, components: best.components };
}

/** 循环 / 归位检测主入口（§6.5 / A.10）：seam 四分量 + verdict + bestLoopRange */
export function computeLoopCheck(
  sample: SampleResult,
  channels: FrameChannels,
  options: LoopCheckOptions = {},
): LoopCheck {
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1;
  const mode = options.loopMode ?? 'strict';
  const n = sample.frameCount;
  const jointCount = sample.joints.length;
  const poses = buildPoses(sample, channels, scale);
  const vel = buildVelocities(sample, scale);
  const seamPose = poseDistance(poses, 0, n, sample);
  const rootDisp = rootDispBetween(sample, scale, 0, n);
  const headingDiff = wrapDegrees(endpointHeading(sample) - (channels.heading[0] ?? 0));
  const velSeam = velocitySeam(vel, 0, n, jointCount);
  const poseMatch =
    seamPose.rms < POSE_RMS_TH && seamPose.maxJoint < POSE_MAX_TH && Math.abs(headingDiff) < HEADING_TH;
  const positionMatch = rootDisp < ROOT_DISP_TH;
  const velocityMatch = velSeam < VEL_SEAM_TH;
  return {
    referenceFrame: 0,
    poseMatch,
    positionMatch,
    velocityMatch,
    components: componentsOf(seamPose, rootDisp, headingDiff, velSeam),
    verdict: verdictOf(poseMatch, positionMatch, velocityMatch),
    worstJoints: seamPose.worstJoints,
    bestLoopRange: scanBestLoopRange(sample, channels, poses, vel, scale, mode),
  };
}
