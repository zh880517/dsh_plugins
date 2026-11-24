// M6 动作分析常数总表（design.md 附录 A.15）：所有阈值的单一来源，随输出回显、可审计。
// 校准调整必须只改这里，并跑 A.16 快照测试；调整原因按「资产 / 现象 / 决定」记进头注释。
//
// CALIB_VERSION 0 → 1（2026-11-24，真实资产交验）：
// - 资产：1005_tacy attack_00/01/02/04（Max Biped，真实英雄攻击四份）。
// - 现象：全片档 4/4 全 extreme（max(mean,peak) 口径无区分度，0.2s 轻击与 2.3s 大招同档）；
//   带垫步/转体的挥击段被移动类规则抢先命中（3/4 首段 guess=walk）。
// - 决定：全片档改为只按均值（intensityLevel(meanE, meanE)，爆发由分段档体现）；段档保持
//   max(mean, peak) 不变；A.8 新增「末端主导 strike」前置判据（STRIKE_DOMINANCE×根速度，
//   高转向段豁免），阈值列于本表。

/** 校准版本号：随 summary 回显，任何输出可追溯到哪一版校准（A.16） */
export const CALIB_VERSION = '1';

/** 采样率缺省与边界（§6.7：1–60）；单 clip 一次分析的采样点数上限（A.14） */
export const SAMPLE_FPS_DEFAULT = 15;
export const SAMPLE_FPS_MIN = 1;
export const SAMPLE_FPS_MAX = 60;
export const SAMPLE_COUNT_MAX = 24000;

/** 能量平滑半窗（窗宽 2m+1 = 5，A.2/A.7）；根平面速度的平滑固定 m=1（A.5） */
export const SMOOTH_M = 2;
export const MOVE_SMOOTH_M = 1;

/** 接触检测双阈值（A.6）：脚点高度 < 0.05H 且速度 < 0.30 H/s；状态翻转需连续 2 帧成立 */
export const CONTACT_HEIGHT = 0.05;
export const CONTACT_VEL = 0.3;
export const DEBOUNCE_FRAMES = 2;

/** 分段（A.7）：局部极小显著性 / 最短段长 / 段数上限 */
export const SEG_DELTA = 0.08;
export const SEG_MIN_SECONDS = 0.4;
export const SEG_MAX_COUNT = 24;

/** 循环 / 归位阈值（A.10）：姿势 RMS、最差单关节、根位移、朝向差、速度 seam */
export const POSE_RMS_TH = 0.03;
export const POSE_MAX_TH = 0.08;
export const ROOT_DISP_TH = 0.05;
export const HEADING_TH = 10;
export const VEL_SEAM_TH = 0.1;
export const LOOP_GRID = 300;
export const LOOP_MIN_SECONDS = 0.5;
export const LOOP_PASS = 1.5;

/** 循环 / 归位 verdict 四态（§6.5.3 表） */
export type LoopVerdict = 'loop-perfect' | 'loop-pose-only' | 'return-only' | 'no-return';

/** verdict 释义四句固定文案（A.12 循环 facts 句的 {verdict 释义}；文案随 §6.5.3 表走） */
export const LOOP_VERDICT_NOTES: Record<LoopVerdict, string> = {
  'loop-perfect': '可无缝循环（走路循环、待机呼吸）',
  'loop-pose-only': '姿势回起点但速度断裂——循环会有顿挫（收招后停顿一拍的动作）',
  'return-only': '姿势归位、位置漂移——root-motion 位移动作，复用要代码处理位移',
  'no-return': '不归位（一次性动作：死亡、倒地、受击落僵直）',
};

/** 分段决策表（A.8）：打击峰值/时长、跑/走分界、转身净角、自转累计角 */
export const STRIKE_PEAK = 2.0;
export const STRIKE_DUR = 0.8;
/** 末端主导 strike 前置判据（A.8 #2/#3，0.5.1）：peakJointSpeed ≥ 该倍数 × max(rootSpeed, 0.1) */
export const STRIKE_DOMINANCE = 3;
/** 末端主导 strike 的高转向豁免（A.8 #2/#3）：净转角 ≥ 此值的段仍按 turn/spin 判（旋转类动作）。
 *  200° = 真实资产校准（attack 系列 118–160° 命中 strike；turnTotal ≥ 270° 的旋转类走 spin） */
export const STRIKE_TURN_NET_MAX = 200;
export const RUN_SPEED = 1.2;
export const WALK_SPEED = 0.3;
export const TURN_TH = 45;
export const SPIN_TH = 270;

/** 关键帧挑选（A.11）：上限 / 帧距去重 / 参与挑选的段数（按 peakE 降序） */
export const KEYFRAME_MAX = 8;
export const KEYFRAME_DEDUP = 0.3;
export const KEYFRAME_SEGMENT_TOP = 6;

/** 事件时间轴（A.7）：全片上限 / 方向切换需此后稳定的帧数 */
export const EVENTS_MAX = 32;
export const DIRECTION_STABLE_FRAMES = 3;

/** hipsLow 判据偏移（A.8 #10）：段内 hips 均值 < 全片 P10 − 0.05 */
export const HIPS_LOW_OFFSET = 0.05;

/** trajectory SVG 强度五档着色（A.13，按能量着色） */
export const LEVEL_COLORS: Record<IntensityLevel, string> = {
  static: '#dddddd',
  low: '#b3de69',
  medium: '#fdb462',
  high: '#fb8072',
  extreme: '#9e0142',
};

/** trajectory SVG 采样圆点抽稀上限（A.13：帧多时按 stride 抽稀到 ≤ 600 个） */
export const TRAJECTORY_MAX_DOTS = 600;

/** trajectory SVG 单文件字节上限（A.13：超限时路径按 2 的幂步长抽稀到 fit，SVG 内 desc 标注） */
export const TRAJECTORY_MAX_BYTES = 32 * 1024;

/**
 * 强度档位（§6.6.2，A.9）：mean 按「平均能量」列、peak 按「峰值能量」列各判一档，
 * level = 取更高级别（防高爆发短段被均值稀释）。全片与每帧同用本表。
 */
export const INTENSITY_LEVELS = [
  { level: 'static', meanBelow: 0.05, peakBelow: 0.3 },
  { level: 'low', meanBelow: 0.15, peakBelow: 0.8 },
  { level: 'medium', meanBelow: 0.4, peakBelow: 1.6 },
  { level: 'high', meanBelow: 0.8, peakBelow: 3.0 },
  { level: 'extreme', meanBelow: Number.POSITIVE_INFINITY, peakBelow: Number.POSITIVE_INFINITY },
] as const;

export type IntensityLevel = (typeof INTENSITY_LEVELS)[number]['level'];

const LEVEL_RANK: Record<IntensityLevel, number> = {
  static: 0,
  low: 1,
  medium: 2,
  high: 3,
  extreme: 4,
};

function tierOf(value: number, pick: 'meanBelow' | 'peakBelow'): IntensityLevel {
  for (const tier of INTENSITY_LEVELS) {
    if (value < tier[pick]) return tier.level;
  }
  return 'extreme';
}

/** level = max(levelMean(meanE), levelPeak(peakE))（A.9）。每帧同用：mean = peak = 该帧能量 */
export function intensityLevel(mean: number, peak: number): IntensityLevel {
  const byMean = tierOf(mean, 'meanBelow');
  const byPeak = tierOf(peak, 'peakBelow');
  return LEVEL_RANK[byMean] >= LEVEL_RANK[byPeak] ? byMean : byPeak;
}

/**
 * 能量权重表（A.3，J15）：末端关节权重高、躯干低；左右同权。
 * J15 全集 Σw = 11.5（躯干 1.5 + 左右成对肢链 2×5.0）；实际计算按解析到的关节子集求和
 * （channels.ts），不使用预合计常量。Toe 只作足点/打击肢端候选，不在权重表里（weight = 0）。
 */
export const JOINT_WEIGHTS = {
  hips: 0.2,
  spine: 0.3,
  head: 1.0,
  UpperArm: 0.7,
  LowerArm: 0.9,
  Hand: 1.2,
  UpperLeg: 0.5,
  LowerLeg: 0.7,
  Foot: 1.0,
} as const;

// ———————— M7 骨架映射（附录 B.3 / B.4，随 skeleton-report 回显） ————————

/** 约定识别判定的最低指纹分（B.3）：score ≥ 0.5 才认该约定，否则 custom */
export const CONVENTION_MIN = 0.5;

/** 骨骼名标注截图的每批骨骼数（B.4）：按 DFS 序号 mod 批数 stride 分批防叠 */
export const LABELS_PER_SHOT = 12;
