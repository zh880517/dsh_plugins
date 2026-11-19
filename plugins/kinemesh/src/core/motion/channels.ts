// 派生通道（design.md 附录 A.2–A.6）：速度 / 能量 / 幅度 / 朝向 / 根位移与方向 / 接触腾空。
// 纯数组数学（不依赖 three / DOM），输入是 sample.ts 的世界坐标，输出按采样帧对齐的通道值。
// 所有长度除以 scale（身高归一），速度单位 H/s；输出圆整在 report.ts 序列化时做（A.14）。
import {
  CONTACT_HEIGHT,
  CONTACT_VEL,
  DEBOUNCE_FRAMES,
  MOVE_SMOOTH_M,
  intensityLevel,
} from './constants.js';
import type { SampleResult } from './sample.js';

export interface ChannelsOptions {
  /** 长度归一分母（模型身高 H；normalize=none 时为 1）。缺省 1 */
  scale?: number;
}

export interface FrameChannels {
  frameCount: number;
  /** 帧号 frame(t)=round(t×30)，与 kinemesh_render 同口径 */
  frames: number[];
  /** 采样网格时刻（秒） */
  times: number[];
  /** 加权平均关节线速度（H/s），A.3 */
  energy: number[];
  energyLevel: string[];
  /** 主要关节到躯干轴平均距离（H），A.3 */
  amplitude: number[];
  /** rootPos − rootPos(0)，H */
  rootX: number[];
  rootY: number[];
  rootZ: number[];
  /** 朝向角（度），A.4 */
  heading: number[];
  /** 累计转角（度）：Σ|wrap(Δheading)|，A.4——整圈旋转用，净差会掩盖 */
  turnTotal: number[];
  /** 平面位移方向 → 8 方位词（相对初始朝向），A.5 */
  moveDir: string[];
  /** 同上，相对当前朝向（倒退 / 侧移判据），A.5 */
  moveDirBody: string[];
  /** 根平面速度（H/s），A.5 */
  moveSpeed: number[];
  contactL: boolean[];
  contactR: boolean[];
  airborne: boolean[];
  /** double-support / single-L / single-R / air，A.6 */
  support: string[];
  /** 本帧线速度最高的关节 id（平手取权重更大者，再取关节序），A.6.3 表 */
  topJoint: string[];
  topJointSpeed: number[];
}

const DIR_WORDS = [
  'forward',
  'forward-right',
  'right',
  'back-right',
  'back',
  'back-left',
  'left',
  'forward-left',
] as const;

/** wrap(θ) = ((θ + 180) mod 360) − 180，值域 [−180, 180)（A.4） */
function wrapDegrees(theta: number): number {
  return ((((theta + 180) % 360) + 360) % 360) - 180;
}

function norm3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** 居中滑动平均（A.2）：窗宽 2m+1，端点用截断窗口 */
function smooth(values: number[] | Float64Array, m: number): number[] {
  const out = new Array<number>(values.length);
  for (let k = 0; k < values.length; k += 1) {
    const from = Math.max(0, k - m);
    const to = Math.min(values.length - 1, k + m);
    let sum = 0;
    for (let i = from; i <= to; i += 1) sum += values[i]!;
    out[k] = sum / (to - from + 1);
  }
  return out;
}

export function computeChannels(sample: SampleResult, options: ChannelsOptions = {}): FrameChannels {
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1;
  const n = sample.frameCount;
  const jointCount = sample.joints.length;
  const dt = sample.dt;
  const { anchors, joints } = sample;

  // 位置先 /H 再差分（A.2 固定口径）
  const raw = sample.positions;
  const pos = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) pos[i] = raw[i]! / scale;

  const at = (k: number, j: number): [number, number, number] => {
    const base = (k * jointCount + j) * 3;
    return [pos[base]!, pos[base + 1]!, pos[base + 2]!];
  };

  // ———— 速度：内部中央差分、端点单侧（A.2） ————
  const vel = new Float64Array(n * jointCount * 3);
  for (let j = 0; j < jointCount; j += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const series = new Float64Array(n);
      for (let k = 0; k < n; k += 1) series[k] = at(k, j)[axis]!;
      const d = new Float64Array(n);
      for (let k = 0; k < n; k += 1) {
        if (k === 0) d[k] = (series[1]! - series[0]!) / dt;
        else if (k === n - 1) d[k] = (series[n - 1]! - series[n - 2]!) / dt;
        else d[k] = (series[k + 1]! - series[k - 1]!) / (2 * dt);
      }
      for (let k = 0; k < n; k += 1) vel[(k * jointCount + j) * 3 + axis] = d[k]!;
    }
  }
  const speedAt = (k: number, j: number): number => {
    const base = (k * jointCount + j) * 3;
    return norm3(vel[base]!, vel[base + 1]!, vel[base + 2]!);
  };

  // ———— 能量：加权平均关节线速度（A.3） ————
  let weightSum = 0;
  for (const joint of joints) weightSum += joint.weight;
  const energy = new Array<number>(n).fill(0);
  if (weightSum > 0) {
    for (let k = 0; k < n; k += 1) {
      let sum = 0;
      for (let j = 0; j < jointCount; j += 1) sum += joints[j]!.weight * speedAt(k, j);
      energy[k] = sum / weightSum;
    }
  }
  const energyLevel = energy.map((value) => intensityLevel(value, value));

  // ———— 幅度：末端到躯干轴（hips→head）平均距离（A.3） ————
  const amplitude = new Array<number>(n).fill(0);
  if (anchors.hips >= 0 && anchors.head >= 0 && anchors.endEffectors.length > 0) {
    for (let k = 0; k < n; k += 1) {
      const [p1x, p1y, p1z] = at(k, anchors.hips);
      const [p2x, p2y, p2z] = at(k, anchors.head);
      const ux = p2x - p1x;
      const uy = p2y - p1y;
      const uz = p2z - p1z;
      const len = norm3(ux, uy, uz);
      if (len < 1e-9) continue;
      const unitX = ux / len;
      const unitY = uy / len;
      const unitZ = uz / len;
      let sum = 0;
      for (const eff of anchors.endEffectors) {
        const [ex, ey, ez] = at(k, eff);
        const vx = ex - p1x;
        const vy = ey - p1y;
        const vz = ez - p1z;
        const cx = vy * unitZ - vz * unitY;
        const cy = vz * unitX - vx * unitZ;
        const cz = vx * unitY - vy * unitX;
        sum += norm3(cx, cy, cz);
      }
      amplitude[k] = sum / anchors.endEffectors.length;
    }
  }

  // ———— 朝向（A.4）：right × up；缺腿/退化时用 rootJoint 世界四元数回退 ————
  const heading = new Array<number>(n).fill(0);
  const rootTrack = sample.rootTrack;
  for (let k = 0; k < n; k += 1) {
    let fx = 0;
    let fz = 0;
    let resolved = false;
    if (anchors.hips >= 0 && anchors.head >= 0 && anchors.leftUpperLeg >= 0 && anchors.rightUpperLeg >= 0) {
      const [lux, luy, luz] = at(k, anchors.leftUpperLeg);
      const [rux, ruy, ruz] = at(k, anchors.rightUpperLeg);
      const rx = rux - lux;
      const ry = ruy - luy;
      const rz = ruz - luz;
      const [hpx, hpy, hpz] = at(k, anchors.hips);
      const [hdx, hdy, hdz] = at(k, anchors.head);
      const ux = hdx - hpx;
      const uy = hdy - hpy;
      const uz = hdz - hpz;
      if (norm3(rx, ry, rz) > 1e-9 && norm3(ux, uy, uz) > 1e-9) {
        const cx = ry * uz - rz * uy;
        const cy = rz * ux - rx * uz;
        const cz = rx * uy - ry * ux;
        const len = norm3(cx, cy, cz);
        if (len > 1e-9) {
          fx = cx / len;
          fz = cz / len;
          resolved = true;
        }
      }
    }
    if (!resolved && rootTrack) {
      // 回退：(0,0,1) 经根骨骼世界四元数旋转后投影 XZ（A.4 非人形/缺腿口径）
      const qx = rootTrack.quaternions[k * 4]!;
      const qy = rootTrack.quaternions[k * 4 + 1]!;
      const qz = rootTrack.quaternions[k * 4 + 2]!;
      const qw = rootTrack.quaternions[k * 4 + 3]!;
      const vx = 2 * (qw * qy + qx * qz);
      const vy = 2 * (qy * qz - qw * qx);
      const vz = 1 - 2 * (qx * qx + qy * qy);
      if (Math.sqrt(vx * vx + vz * vz) > 1e-9) {
        fx = vx;
        fz = vz;
        resolved = true;
      }
    }
    heading[k] = resolved ? (Math.atan2(fx, fz) * 180) / Math.PI : 0;
  }

  // ———— turnTotal（A.4）：累计转角 = Σ|wrap(Δheading)|，整圈旋转的判据 ————
  const turnTotal = new Array<number>(n).fill(0);
  for (let k = 1; k < n; k += 1) {
    turnTotal[k] = turnTotal[k - 1]! + Math.abs(wrapDegrees(heading[k]! - heading[k - 1]!));
  }

  // ———— rootPos（A.5）：hips（非人形 = 最上骨骼），减初值、/H ————
  const rootX = new Array<number>(n).fill(0);
  const rootY = new Array<number>(n).fill(0);
  const rootZ = new Array<number>(n).fill(0);
  let rootVelX = new Array<number>(n).fill(0);
  let rootVelZ = new Array<number>(n).fill(0);
  if (rootTrack) {
    const ref0x = rootTrack.positions[0]! / scale;
    const ref0y = rootTrack.positions[1]! / scale;
    const ref0z = rootTrack.positions[2]! / scale;
    const absX = new Float64Array(n);
    const absZ = new Float64Array(n);
    for (let k = 0; k < n; k += 1) {
      rootX[k] = rootTrack.positions[k * 3]! / scale - ref0x;
      rootY[k] = rootTrack.positions[k * 3 + 1]! / scale - ref0y;
      rootZ[k] = rootTrack.positions[k * 3 + 2]! / scale - ref0z;
      absX[k] = rootTrack.positions[k * 3]! / scale;
      absZ[k] = rootTrack.positions[k * 3 + 2]! / scale;
    }
    const diff = (series: Float64Array): number[] => {
      const out = new Array<number>(n).fill(0);
      for (let k = 0; k < n; k += 1) {
        if (k === 0) out[k] = (series[1]! - series[0]!) / dt;
        else if (k === n - 1) out[k] = (series[n - 1]! - series[n - 2]!) / dt;
        else out[k] = (series[k + 1]! - series[k - 1]!) / (2 * dt);
      }
      return out;
    };
    // XZ 分量后 smooth(m=1)（A.5 固定口径）
    rootVelX = smooth(diff(absX), MOVE_SMOOTH_M);
    rootVelZ = smooth(diff(absZ), MOVE_SMOOTH_M);
  }
  const moveSpeed = rootVelX.map((vx, k) => Math.sqrt(vx * vx + rootVelZ[k]! * rootVelZ[k]!));

  // ———— moveDir / moveDirBody（A.5）：8 方位离散化，慢速记 in-place ————
  const moveDir = new Array<string>(n).fill('in-place');
  const moveDirBody = new Array<string>(n).fill('in-place');
  const IN_PLACE_SPEED = 0.05;
  const sectorOf = (vx: number, vz: number, thetaDeg: number): string => {
    const theta = (thetaDeg * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const rotatedX = vx * cos - vz * sin;
    const rotatedZ = vx * sin + vz * cos;
    const phi = Math.atan2(rotatedX, rotatedZ);
    const sector = Math.round(phi / (Math.PI / 4));
    return DIR_WORDS[(((sector % 8) + 8) % 8)]!;
  };
  for (let k = 0; k < n; k += 1) {
    if (moveSpeed[k]! < IN_PLACE_SPEED) continue;
    moveDir[k] = sectorOf(rootVelX[k]!, rootVelZ[k]!, heading[0]!);
    moveDirBody[k] = sectorOf(rootVelX[k]!, rootVelZ[k]!, heading[k]!);
  }

  // ———— 接触与腾空（A.6）：高度 + 速度双阈值，逐脚 OR 后去抖 ————
  const contactL = new Array<boolean>(n).fill(false);
  const contactR = new Array<boolean>(n).fill(false);
  if (anchors.footPoints.length > 0) {
    let ground = Number.POSITIVE_INFINITY;
    for (const point of anchors.footPoints) {
      for (let k = 0; k < n; k += 1) {
        ground = Math.min(ground, raw[(k * jointCount + point.index) * 3 + 1]!);
      }
    }
    const rawContact = (side: 'L' | 'R', k: number): boolean => {
      for (const point of anchors.footPoints) {
        if (point.side !== side) continue;
        const y = raw[(k * jointCount + point.index) * 3 + 1]!;
        if ((y - ground) / scale < CONTACT_HEIGHT && speedAt(k, point.index) < CONTACT_VEL) return true;
      }
      return false;
    };
    const debounced = (side: 'L' | 'R'): boolean[] => {
      const raws = Array.from({ length: n }, (_, k) => rawContact(side, k));
      const out = raws.slice();
      let state = raws[0]!;
      let runStart = -1;
      let runValue = false;
      let runLength = 0;
      for (let k = 1; k < n; k += 1) {
        if (raws[k] !== state) {
          if (runStart >= 0 && raws[k] === runValue) runLength += 1;
          else {
            runValue = raws[k]!;
            runStart = k;
            runLength = 1;
          }
          if (runLength >= DEBOUNCE_FRAMES) {
            for (let i = runStart; i <= k; i += 1) out[i] = runValue;
            state = runValue;
            runStart = -1;
            runLength = 0;
          }
        } else {
          runStart = -1;
          runLength = 0;
        }
      }
      return out;
    };
    const left = debounced('L');
    const right = debounced('R');
    for (let k = 0; k < n; k += 1) {
      contactL[k] = left[k]!;
      contactR[k] = right[k]!;
    }
  }
  const airborne = contactL.map((l, k) => !l && !contactR[k]!);
  const support = airborne.map((air, k) => {
    if (contactL[k]! && contactR[k]!) return 'double-support';
    if (contactL[k]!) return 'single-L';
    if (contactR[k]!) return 'single-R';
    return 'air';
  });

  // ———— topJoint（A.6 表 / §6.3）：本帧线速度最高的关节；平手取权重更大者，再取关节序 ————
  const topJoint = new Array<string>(n).fill('');
  const topJointSpeed = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k += 1) {
    let best = -1;
    let bestSpeed = 0;
    for (let j = 0; j < jointCount; j += 1) {
      const speed = speedAt(k, j);
      if (best < 0 || speed > bestSpeed + 1e-12) {
        best = j;
        bestSpeed = speed;
      } else if (Math.abs(speed - bestSpeed) <= 1e-12 && joints[j]!.weight > joints[best]!.weight) {
        // 平手取权重更大者（A.8 peakJoint 同规则），权重也相同则保持关节序（先到先得）
        best = j;
        bestSpeed = speed;
      }
    }
    topJoint[k] = best >= 0 ? joints[best]!.id : '';
    topJointSpeed[k] = bestSpeed;
  }

  return {
    frameCount: n,
    frames: sample.frames,
    times: sample.times,
    energy,
    energyLevel,
    amplitude,
    rootX,
    rootY,
    rootZ,
    heading,
    turnTotal,
    moveDir,
    moveDirBody,
    moveSpeed,
    contactL,
    contactR,
    airborne,
    support,
    topJoint,
    topJointSpeed,
  };
}
