// A.16 阈值校准回路快照（design.md A.15 / A.16 / §6.9 M6f）。
//
// 本文件是 constants.ts 的「防静默漂移」快照：期望值表内嵌、按 CALIB_VERSION 键索引。
// 任何 constants.ts 改动跑此测试会红，强迫走 A.16 流程：
//   1. 在 constants.ts 头注释记下「资产 / 现象 / 调整原因」；
//   2. 用合成 rig（本文件）+ 真实资产核对 summary 关键字段的新值；
//   3. 在下方 SNAPSHOTS 增加新 CALIB_VERSION 的期望表（旧表保留不删）；
//   4. bump CALIB_VERSION（summary 随输出回显 calibVersion，任何输出可追溯）。
// 容差口径：数值 toBeCloseTo(期望, 2)（圆整 3 位小数的两位容差）；verdict/guess/方向词精确相等。
import { describe, expect, it } from 'vitest';
import {
  buildHumanoidRig,
  buildJumpClip,
  buildLinearWalkClip,
  buildPunchClip,
  buildRigScene,
} from '../support/kinemesh-rig-fixtures.js';
import { analyzeClip } from '../../plugins/kinemesh/src/core/motion/analyze.js';
import {
  CALIB_VERSION,
  CONTACT_HEIGHT,
  CONTACT_VEL,
  DEBOUNCE_FRAMES,
  DIRECTION_STABLE_FRAMES,
  EVENTS_MAX,
  HIPS_LOW_OFFSET,
  HEADING_TH,
  INTENSITY_LEVELS,
  KEYFRAME_DEDUP,
  KEYFRAME_MAX,
  KEYFRAME_SEGMENT_TOP,
  LOOP_GRID,
  LOOP_MIN_SECONDS,
  LOOP_PASS,
  MOVE_SMOOTH_M,
  POSE_MAX_TH,
  POSE_RMS_TH,
  ROOT_DISP_TH,
  RUN_SPEED,
  SAMPLE_COUNT_MAX,
  SAMPLE_FPS_DEFAULT,
  SAMPLE_FPS_MAX,
  SAMPLE_FPS_MIN,
  SEG_DELTA,
  SEG_MAX_COUNT,
  SEG_MIN_SECONDS,
  SMOOTH_M,
  STRIKE_DUR,
  STRIKE_PEAK,
  SPIN_TH,
  STRIKE_DOMINANCE,
  STRIKE_TURN_NET_MAX,
  TRAJECTORY_MAX_BYTES,
  TRAJECTORY_MAX_DOTS,
  TURN_TH,
  VEL_SEAM_TH,
  WALK_SPEED,
  intensityLevel,
} from '../../plugins/kinemesh/src/core/motion/constants.js';

/** 期望值表：键 = CALIB_VERSION（A.16 第 4 步）；数值为当前校准版下合成 rig 的实测答案 */
const SNAPSHOTS: Record<string, ConstantsExpectations> = {
  '0': {
    // 期望侧必须是纯字面量（抄自当前 constants.ts），与 actual 侧的导入值解耦——
    // 否则两侧同一绑定、改常数两侧同步变，闸门失效
    constants: {
      SAMPLE_FPS_DEFAULT: 15,
      SAMPLE_FPS_MIN: 1,
      SAMPLE_FPS_MAX: 60,
      SAMPLE_COUNT_MAX: 24000,
      SMOOTH_M: 2,
      MOVE_SMOOTH_M: 1,
      CONTACT_HEIGHT: 0.05,
      CONTACT_VEL: 0.3,
      DEBOUNCE_FRAMES: 2,
      SEG_DELTA: 0.08,
      SEG_MIN_SECONDS: 0.4,
      SEG_MAX_COUNT: 24,
      POSE_RMS_TH: 0.03,
      POSE_MAX_TH: 0.08,
      ROOT_DISP_TH: 0.05,
      HEADING_TH: 10,
      VEL_SEAM_TH: 0.1,
      LOOP_GRID: 300,
      LOOP_MIN_SECONDS: 0.5,
      LOOP_PASS: 1.5,
      STRIKE_PEAK: 2.0,
      STRIKE_DUR: 0.8,
      RUN_SPEED: 1.2,
      WALK_SPEED: 0.3,
      TURN_TH: 45,
      SPIN_TH: 270,
      KEYFRAME_MAX: 8,
      KEYFRAME_DEDUP: 0.3,
      KEYFRAME_SEGMENT_TOP: 6,
      EVENTS_MAX: 32,
      DIRECTION_STABLE_FRAMES: 3,
      HIPS_LOW_OFFSET: 0.05,
      TRAJECTORY_MAX_DOTS: 600,
      TRAJECTORY_MAX_BYTES: 32768,
    },
    jump: {
      verdict: 'loop-perfect',
      guesses: ['gesture', 'jump', 'fall', 'idle'],
      airTime: 0.9333, // 14 采样帧 / 15fps
      airborneFrames: 14,
      maxRootYGain: 0.3852, // 顶点 +0.4 局部、按包围盒身高归一的实测值
    },
    punch: {
      guesses: ['gesture', 'strike-punch', 'recover'],
      strikePeakE: 4.4939, // 打击段平滑峰值能量（fixture 文档手推值 ≈5.29 为未平滑口径）
      level: 'extreme',
    },
    walk: {
      mainDir: 'forward',
      energyMean: 1.0, // 全身随 hips 刚体平移：Σw·v/Σw = 1 H/s
      rootTotalDisp: 2, // 0.5s×... speed 1 H/s × 2s
      verdict: 'return-only', // 位置漂移 2H 不归位
    },
  },
  // CALIB v1（2026-11-24，真实资产 1005_tacy attack_00/01/02/04 交验）：
  // 常数表与 v0 相同（阈值未动）；口径变化 = 全片档只按均值 + A.8 末端主导前置判据。
  // punch 全片档按均值复核后仍为 extreme（fixture 全程高能量）。
  '1': {
    constants: {
      SAMPLE_FPS_DEFAULT: 15,
      SAMPLE_FPS_MIN: 1,
      SAMPLE_FPS_MAX: 60,
      SAMPLE_COUNT_MAX: 24000,
      SMOOTH_M: 2,
      MOVE_SMOOTH_M: 1,
      CONTACT_HEIGHT: 0.05,
      CONTACT_VEL: 0.3,
      DEBOUNCE_FRAMES: 2,
      SEG_DELTA: 0.08,
      SEG_MIN_SECONDS: 0.4,
      SEG_MAX_COUNT: 24,
      POSE_RMS_TH: 0.03,
      POSE_MAX_TH: 0.08,
      ROOT_DISP_TH: 0.05,
      HEADING_TH: 10,
      VEL_SEAM_TH: 0.1,
      LOOP_GRID: 300,
      LOOP_MIN_SECONDS: 0.5,
      LOOP_PASS: 1.5,
      STRIKE_PEAK: 2.0,
      STRIKE_DUR: 0.8,
      STRIKE_DOMINANCE: 3,
      STRIKE_TURN_NET_MAX: 120,
      RUN_SPEED: 1.2,
      WALK_SPEED: 0.3,
      TURN_TH: 45,
      SPIN_TH: 270,
      KEYFRAME_MAX: 8,
      KEYFRAME_DEDUP: 0.3,
      KEYFRAME_SEGMENT_TOP: 6,
      EVENTS_MAX: 32,
      DIRECTION_STABLE_FRAMES: 3,
      HIPS_LOW_OFFSET: 0.05,
      TRAJECTORY_MAX_DOTS: 600,
      TRAJECTORY_MAX_BYTES: 32768,
    },
    jump: {
      verdict: 'loop-perfect',
      guesses: ['gesture', 'jump', 'fall', 'idle'],
      airTime: 0.9333,
      airborneFrames: 14,
      maxRootYGain: 0.3852,
    },
    punch: {
      guesses: ['gesture', 'strike-punch', 'recover'],
      strikePeakE: 4.4939,
      level: 'extreme',
    },
    walk: {
      mainDir: 'forward',
      energyMean: 1.0,
      rootTotalDisp: 2,
      verdict: 'return-only',
    },
  },
};

interface ConstantsExpectations {
  constants: Record<string, number>;
  jump: { verdict: string; guesses: string[]; airTime: number; airborneFrames: number; maxRootYGain: number };
  punch: { guesses: string[]; strikePeakE: number; level: string };
  walk: { mainDir: string; energyMean: number; rootTotalDisp: number; verdict: string };
}

function runFixture(kind: 'jump' | 'punch' | 'walk') {
  const rig = buildHumanoidRig();
  const clip = kind === 'jump' ? buildJumpClip(rig) : kind === 'punch' ? buildPunchClip(rig) : buildLinearWalkClip(rig);
  return analyzeClip(buildRigScene(rig.root, [clip]));
}

describe('A.16 校准快照 · 流程闸门', () => {
  it('CALIB_VERSION 必须有对应期望表——改 constants 先按 A.16 走：记因 → 核对 → 建表 → bump', () => {
    const snapshot = SNAPSHOTS[CALIB_VERSION];
    expect(
      snapshot,
      `CALIB_VERSION「${CALIB_VERSION}」没有期望表。按 A.16：在 constants.ts 头注释记录「资产/现象/调整原因」，` +
        '核对新值后在 motion-calib.test.ts 的 SNAPSHOTS 增加该版本期望表，再 bump CALIB_VERSION。',
    ).toBeDefined();
    expect(CALIB_VERSION).toBe('1'); // 当前唯一已校准版本；bump 后改这里并在 SNAPSHOTS 加新表
  });
});

describe('A.16 校准快照 · A.15 常数总表', () => {
  it('constants.ts 全部阈值逐项对表（期望表 = 字面量快照；改任何一处都会红）', () => {
    const expected = SNAPSHOTS[CALIB_VERSION]!.constants;
    const actual: Record<string, number> = {
      SAMPLE_FPS_DEFAULT,
      SAMPLE_FPS_MIN,
      SAMPLE_FPS_MAX,
      SAMPLE_COUNT_MAX,
      SMOOTH_M,
      MOVE_SMOOTH_M,
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
      STRIKE_DOMINANCE,
      STRIKE_TURN_NET_MAX,
      RUN_SPEED,
      WALK_SPEED,
      TURN_TH,
      SPIN_TH,
      KEYFRAME_MAX,
      KEYFRAME_DEDUP,
      KEYFRAME_SEGMENT_TOP,
      EVENTS_MAX,
      DIRECTION_STABLE_FRAMES,
      HIPS_LOW_OFFSET,
      TRAJECTORY_MAX_DOTS,
      TRAJECTORY_MAX_BYTES,
    };
    expect(actual).toEqual(expected);
  });

  it('A.9 强度档位边界（档位表改动也会红）', () => {
    expect(INTENSITY_LEVELS.map((tier) => tier.level)).toEqual(['static', 'low', 'medium', 'high', 'extreme']);
    expect(intensityLevel(0.049, 0.29)).toBe('static');
    expect(intensityLevel(0.05, 0.3)).toBe('low');
    expect(intensityLevel(0.39, 0.79)).toBe('medium');
    expect(intensityLevel(0.4, 0.8)).toBe('high');
    expect(intensityLevel(0.8, 3.0)).toBe('extreme');
    // 每帧口径：level = max(均值档, 峰值档)——高爆发短段不被均值稀释
    expect(intensityLevel(0.01, 2.0)).toBe('high');
  });
});

describe('A.16 校准快照 · 合成资产 summary 关键字段（容差断言）', () => {
  it('summary 回显 calibVersion（A.16 第 4 步：输出可追溯到校准版本）', () => {
    for (const kind of ['jump', 'punch', 'walk'] as const) {
      expect(runFixture(kind).summary.calibVersion).toBe(CALIB_VERSION);
    }
  });

  it('jump：verdict loop-perfect + 分段 guess 序列 + 腾空统计', () => {
    const expected = SNAPSHOTS[CALIB_VERSION]!.jump;
    const summary = runFixture('jump').summary;
    expect(summary.loopCheck?.verdict).toBe(expected.verdict);
    expect(summary.segments.map((segment) => segment.guess)).toEqual(expected.guesses);
    expect(summary.clipStats.airTime).toBeCloseTo(expected.airTime, 2);
    expect(summary.clipStats.airborneFrames).toBe(expected.airborneFrames);
    expect(summary.clipStats.maxRootYGain).toBeCloseTo(expected.maxRootYGain, 2);
  });

  it('punch：guess 序列含 strike-punch + 打击峰值能量容差 + 全片强度档', () => {
    const expected = SNAPSHOTS[CALIB_VERSION]!.punch;
    const summary = runFixture('punch').summary;
    expect(summary.segments.map((segment) => segment.guess)).toEqual(expected.guesses);
    const strike = summary.segments.find((segment) => segment.guess === 'strike-punch')!;
    expect(strike.features.peakE).toBeCloseTo(expected.strikePeakE, 2);
    expect(summary.clipStats.level).toBe(expected.level);
  });

  it('walk：主方向 forward + 全片能量 ≈ 1H/s + 位移 2H + verdict return-only', () => {
    const expected = SNAPSHOTS[CALIB_VERSION]!.walk;
    const summary = runFixture('walk').summary;
    expect(summary.clipStats.mainDir).toBe(expected.mainDir);
    expect(summary.clipStats.energy.mean).toBeCloseTo(expected.energyMean, 2);
    expect(summary.clipStats.rootTotalDisp).toBeCloseTo(expected.rootTotalDisp, 2);
    expect(summary.loopCheck?.verdict).toBe(expected.verdict);
  });
});
