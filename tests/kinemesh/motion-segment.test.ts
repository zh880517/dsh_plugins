// M6b：分段（A.7 六步）+ 决策表 guess（A.8）+ summary/facts（A.12）+ trajectory（A.13）
// + 关键帧挑选（A.11）。合成跳跃/出拳/倒退走/侧移动画的分段、guess 与事件帧符合构造预期。
// 注意 FK 层级：手臂关节世界速度 = 父链速度之和，expected 全部按世界坐标推。
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { analyzeClip } from '../../plugins/kinemesh/src/core/motion/analyze.js';
import { CALIB_VERSION, SMOOTH_M } from '../../plugins/kinemesh/src/core/motion/constants.js';
import { computeChannels, smoothSeries } from '../../plugins/kinemesh/src/core/motion/channels.js';
import { sampleClip } from '../../plugins/kinemesh/src/core/motion/sample.js';
import {
  buildBackpedalClip,
  buildHumanoidRig,
  buildJumpClip,
  buildLinearWalkClip,
  buildLungeStrikeClip,
  buildPunchClip,
  buildRigScene,
  buildStrafeClip,
} from '../support/kinemesh-rig-fixtures.js';

function run(clip: THREE.AnimationClip) {
  const rig = buildHumanoidRig();
  return analyzeClip(buildRigScene(rig.root, [clip]));
}

describe('M6b · 跳跃（airborne 硬边界 + jump/fall guess + 腾空统计）', () => {
  const result = run(buildJumpClip(buildHumanoidRig()));

  it('分段：[gesture, airborne(jump), airborne(fall), idle]——顶点能量谷按 A.7 切分飞行', () => {
    const { summary } = result;
    expect(summary.segments.map((segment) => segment.label)).toEqual(['action', 'airborne', 'airborne', 'idle']);
    expect(summary.segments.map((segment) => segment.guess)).toEqual(['gesture', 'jump', 'fall', 'idle']);
    expect(summary.segments[1]!.frameStart).toBe(16); // 采样帧 8 × 2（30fps 口径 liftoff）
    expect(summary.segments[1]!.frameEnd).toBe(28);
    expect(summary.segments[2]!.frameStart).toBe(28);
    expect(summary.segments[2]!.frameEnd).toBe(44);
    expect(summary.segments[1]!.features.airRatio).toBeCloseTo(1, 6);
    expect(summary.segments[1]!.features.hipsRise).toBeCloseTo(0.356, 2); // 上升段 hips 峰值升高 ≥ 0.05H → jump
    expect(summary.segments[2]!.features.hipsRise).toBeCloseTo(0, 2); // 下落段未升高 → fall
    expect(summary.segments[1]!.level).toBe('high');
  });

  it('事件：liftoff@16、touchdown@44，无 spin 与 direction-change', () => {
    const { summary } = result;
    const liftoff = summary.events.find((event) => event.type === 'liftoff')!;
    const touchdown = summary.events.find((event) => event.type === 'touchdown')!;
    expect(liftoff.frame).toBe(16);
    expect(touchdown.frame).toBe(44);
    expect(summary.events.some((event) => event.type === 'spin')).toBe(false);
    expect(summary.events.some((event) => event.type === 'direction-change')).toBe(false);
  });

  it('全片统计：airTime = 14/15 s、maxRootYGain ≈ 0.385、主方向 in-place、总位移 0', () => {
    const { summary } = result;
    expect(summary.clipStats.airTime).toBeCloseTo(14 / 15, 6);
    expect(summary.clipStats.maxRootYGain).toBeCloseTo(0.385, 2);
    expect(summary.clipStats.mainDir).toBe('in-place');
    expect(summary.clipStats.rootTotalDisp).toBeCloseTo(0, 6);
    expect(summary.clip.frames).toBe(60);
  });

  it('keyframes：≤ 8 帧，含全片能量峰值与端点（去重后）', () => {
    const { summary } = result;
    expect(summary.keyframes.length).toBeLessThanOrEqual(8);
    expect(summary.keyframes.some((entry) => entry.reason === 'energy-peak')).toBe(true);
    expect(summary.keyframes.some((entry) => entry.reason === 'endpoints')).toBe(true);
  });
});

describe('M6b · 出拳（strike-punch 决策表 #8 + recover #12）', () => {
  const result = run(buildPunchClip(buildHumanoidRig()));

  it('分段 guess 序列：[gesture, strike-punch, recover]', () => {
    const { summary } = result;
    expect(summary.segments.map((segment) => segment.guess)).toEqual(['gesture', 'strike-punch', 'recover']);
    expect(summary.segments.map((segment) => segment.label)).toEqual(['action', 'action', 'action']);
  });

  it('打击段特征：峰值能量 ≥ 2.0、时长 ≤ 0.8s、peakJoint = R.Hand（世界速度 ≈ 32 H/s）', () => {
    const strike = result.summary.segments[1]!;
    expect(strike.frameStart).toBe(20); // 采样帧 10..20
    expect(strike.frameEnd).toBe(40);
    expect(strike.features.peakE).toBeCloseTo(4.49, 2); // Ê 平滑后的打击峰值（原始 5.29）
    expect(strike.features.peakE).toBeGreaterThan(2.0);
    expect(strike.features.dur).toBeCloseTo(11 / 15, 3);
    expect(strike.features.dur).toBeLessThan(0.81);
    expect(strike.features.peakJoint).toBe('R.Hand');
    expect(strike.features.peakJointSpeed).toBeCloseTo(32, 0);
    expect(strike.level).toBe('extreme');
    // relativeLevel 对本 clip Ê 分布：均值被切分谷帧稀释 < P90 → rel-mid（规格行为）
    expect(strike.relativeLevel).toBe('rel-mid');
  });

  it('收招段命中 #12（均值 < 前段一半）→ recover / rel-mid；段依据写进 features.basis', () => {
    const { summary } = result;
    const recover = summary.segments[2]!;
    expect(recover.guess).toBe('recover');
    expect(recover.relativeLevel).toBe('rel-mid');
    expect(recover.features.basis).toContain('前段（strike-punch）');
    expect(summary.segments[1]!.features.basis).toContain('R.Hand');
  });

  it('events 每段一条 energy-peak（带 guess tag）；facts 引用 guess', () => {
    const { summary } = result;
    const peaks = summary.events.filter((event) => event.type === 'energy-peak');
    expect(peaks.map((event) => event.detail)).toEqual(
      expect.arrayContaining([expect.stringContaining('guess=strike-punch')]),
    );
    expect(summary.facts.some((fact) => fact.includes('guess strike-punch'))).toBe(true);
    expect(summary.facts.some((fact) => fact.includes('guess recover'))).toBe(true);
  });
});

describe('M6b · 倒退走（backpedal #3：bodyDir = back）', () => {
  const result = run(buildBackpedalClip(buildHumanoidRig()));

  it('单段 contact-move / backpedal；moveDirBody 全 back、支撑 double-support', () => {
    const { summary } = result;
    expect(summary.segments).toHaveLength(1);
    const segment = summary.segments[0]!;
    expect(segment.label).toBe('contact-move');
    expect(segment.guess).toBe('backpedal');
    // 段终点是最后一个采样帧（k=29，t=1.9333s）：位移 = 0.5 × 1.9333 = 0.9667 → rootSpeed 0.4833
    expect(segment.features.rootSpeed).toBeCloseTo(0.4833, 3);
    expect(segment.features.bodyDir).toBe('back');
    expect(segment.features.support).toBe('double-support');
    expect(segment.level).toBe('high');
  });

  it('全片主方向 back；frames.csv 通道与分段一致（moveDirBody 列全 back）', () => {
    const { summary, files } = result;
    expect(summary.clipStats.mainDir).toBe('back');
    const csv = files.find((file) => file.name === 'motion-frames.csv')!;
    const rows = csv.content.trimEnd().split('\n').slice(1).map((line) => line.split(','));
    expect(rows.every((row) => row[10] === 'back')).toBe(true);
  });
});

describe('M6b · 侧移（strafe-r #4：bodyDir = right）', () => {
  const result = run(buildStrafeClip(buildHumanoidRig()));

  it('单段 contact-move / strafe-r；moveDirBody 全 right；能量 ≈ 0.496 H/s', () => {
    const { summary } = result;
    expect(summary.segments).toHaveLength(1);
    const segment = summary.segments[0]!;
    expect(segment.guess).toBe('strafe-r');
    expect(segment.features.bodyDir).toBe('right');
    expect(segment.features.rootSpeed).toBeCloseTo(0.58, 2);
    expect(segment.features.meanE).toBeCloseTo((9.5 * 0.6) / 11.5, 3);
    expect(segment.level).toBe('high');
  });
});

describe('M6b · summary / trajectory / 中间文件集（standard detail）', () => {
  const result = run(buildBackpedalClip(buildHumanoidRig()));

  it('summary.json：calibVersion / 常数回显 / vocab 来源 / loopCheck 块 / facts 中文', () => {
    const { summary } = result;
    expect(summary.calibVersion).toBe(CALIB_VERSION);
    expect(summary.constants.RUN_SPEED).toBe(1.2);
    expect(summary.vocab).toEqual({ source: 'builtin', entries: 0 });
    // M6c 起恒有 loopCheck（verdict 细节见 motion-loop.test.ts）
    expect(summary.loopCheck).not.toBeNull();
    expect(summary.loopCheck).toHaveProperty('verdict');
    expect(summary.facts).toHaveLength(3); // 每段一句 + 循环句（M6c）+ 全片一句
    expect(summary.facts[2]).toContain('总时长');
    expect(summary.facts[2]).toContain('帧@30fps');
    expect(summary.jointBasis.basis).toBe('humanoid-conventions');
    expect(summary.normalize.mode).toBe('none');
  });

  it('standard detail 出 6 个文件；detail=summary 只出 summary.json', () => {
    expect(result.files.map((file) => file.name)).toEqual([
      'motion-summary.json',
      'motion-frames.csv',
      'motion-segments.json',
      'motion-keyframes.json',
      'motion-trajectory.json',
      'motion-trajectory.svg',
    ]);
    const rig = buildHumanoidRig();
    const minimal = analyzeClip(buildRigScene(rig.root, [buildBackpedalClip(rig)]), { detail: 'summary' });
    expect(minimal.files.map((file) => file.name)).toEqual(['motion-summary.json']);
  });

  it('trajectory JSON：每采样帧一点、单位是身高；SVG：俯视图无文本、≤ 32KB', () => {
    const trajectory = result.files.find((file) => file.name === 'motion-trajectory.json')!;
    const parsed = JSON.parse(trajectory.content) as { points: unknown[]; units: string; stepMarks: unknown[] };
    expect(parsed.points).toHaveLength(30);
    expect(parsed.units).toContain('身高');
    expect(parsed.stepMarks).toHaveLength(0);
    const svg = result.files.find((file) => file.name === 'motion-trajectory.svg')!;
    expect(svg.content).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480">');
    expect(svg.content).toContain('<polyline');
    expect(svg.content).not.toContain('<text');
    expect(svg.bytes).toBeLessThanOrEqual(32 * 1024);
  });

  it('digest 内联分段表 + 全片统计 + keyframeRender 配方（Agent 原样传给 render）', () => {
    const { digest } = result;
    expect(digest.segments).toHaveLength(1);
    expect(digest.clipStats.mainDir).toBe('back');
    expect(digest.keyframeRender.views).toEqual(['front', 'side']);
    expect(digest.keyframeRender.mode).toBe('skeleton');
    expect(digest.keyframeRender.frames.length).toBeGreaterThan(0);
  });
});

describe('总审修复 #2 · describe 的 smooth 半窗与 segment/report 同式（smooth:1 = 原始能量口径）', () => {
  const rig = buildHumanoidRig();
  const scene = buildRigScene(rig.root, [buildPunchClip(rig)]);
  const raw = computeChannels(sampleClip(scene)).energy; // 未平滑能量（A.3 原式）
  const result = analyzeClip(scene, { smooth: 1 });

  it('smooth:1 → m=0：时段 meanE = 段内原始能量均值（旧代码 || SMOOTH_M 会回落 m=2 吃平滑值）', () => {
    const segment = result.summary.segments[1]!;
    // 帧号口径：30fps 显示帧 = 2×采样下标（15fps 采样网格 t=k/15）
    const start = segment.frameStart / 2;
    const end = segment.frameEnd / 2;
    let rawSum = 0;
    let smoothedSum = 0;
    const smoothedM2 = smoothSeries(raw, SMOOTH_M); // 旧代码 smooth:1 实际落到的 m=2 口径（分叉对照）
    for (let k = start; k <= end; k += 1) {
      rawSum += raw[k]!;
      smoothedSum += smoothedM2[k]!;
    }
    const frames = end - start + 1;
    expect(segment.features.meanE).toBeCloseTo(rawSum / frames, 9);
    // 对照：出拳是快瞬态，m=2 平滑显著改变段均值——旧代码在此断言必红
    expect(segment.features.meanE).not.toBeCloseTo(smoothedSum / frames, 3);
  });
});

describe('0.5.1 · 末端主导 strike 前置判据（A.8 #2，真实攻击资产交验回归）', () => {
  const result = run(buildLungeStrikeClip(buildHumanoidRig()));

  it('垫步+快挥（手速 ≈14× 根速度、meanE ≥ 0.8）：guess 判 strike-punch，不再误报 walk', () => {
    const guesses = result.summary.segments.map((segment) => segment.guess);
    expect(guesses).toContain('strike-punch');
    expect(guesses).not.toContain('walk');
    const strike = result.summary.segments.find((segment) => segment.guess === 'strike-punch')!;
    expect(strike.features.peakJoint).toBe('R.Hand');
    expect(strike.features.peakJointSpeed).toBeGreaterThanOrEqual(3 * strike.features.rootSpeed);
    expect(strike.features.basis).toContain('末端主导');
  });

  it('纯匀速走（无末端主导，1× 根速度）不受新判据影响，仍是 walk', () => {
    const walk = run(buildLinearWalkClip(buildHumanoidRig(), { speed: 0.5, duration: 2 }));
    expect(walk.summary.segments.every((segment) => segment.guess !== 'strike-punch')).toBe(true);
  });
});
