// M6c：循环/归位检测（A.10 P(t)/poseRMS/seam 四分量 + §6.5.3 verdict 四态 + bestLoopRange
// + loopMode）+ facts 循环句（A.12）+ keyframes loop-seam（A.11 优先级 4）。
// 四种合成资产 verdict 精确对答案：完美循环（loop-perfect）/ root-motion 步伐（return-only，
// pose-only 找到循环体而 strict 找不到）/ 顿挫（loop-pose-only）/ 不归位（no-return）。
// 构造注意：hips 平移带动全身（刚体），P(t) 减 hips 位置会剥离刚体平移——不归位资产必须有
// 姿态本体变化（Spine 前倾）；摆动只动下腿与手臂，上腿枢轴固定 → heading 恒 0（旋转恒等）。
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { analyzeClip } from '../../plugins/kinemesh/src/core/motion/analyze.js';
import {
  buildHumanoidRig,
  buildLoopJerkClip,
  buildLoopPerfectClip,
  buildLoopPoseOnlyClip,
  buildNoReturnClip,
  buildRigScene,
} from '../support/kinemesh-rig-fixtures.js';

function run(clip: THREE.AnimationClip, options: Parameters<typeof analyzeClip>[1] = {}) {
  const rig = buildHumanoidRig();
  return analyzeClip(buildRigScene(rig.root, [clip]), options);
}

describe('M6c · 完美循环（loop-perfect：位置/姿势/速度全连续）', () => {
  const result = run(buildLoopPerfectClip(buildHumanoidRig()));

  it('关节集 17（J15 + 双 Toe）——velSeam / poseRMS 的 mean_j 分母', () => {
    expect(result.summary.jointBasis.joints).toHaveLength(17);
  });

  it('verdict loop-perfect；seam 四分量全过线（数值 ≈ 0）且阈值随 components 回显', () => {
    const check = result.summary.loopCheck!;
    expect(check.referenceFrame).toBe(0);
    expect(check.verdict).toBe('loop-perfect');
    expect(check.poseMatch).toBe(true);
    expect(check.positionMatch).toBe(true);
    expect(check.velocityMatch).toBe(true);
    expect(check.components.poseRMS).toBeCloseTo(0, 6);
    expect(check.components.maxJoint).toBeCloseTo(0, 6);
    expect(check.components.rootDisp).toBeCloseTo(0, 6);
    expect(check.components.headingDiff).toBeCloseTo(0, 6);
    expect(check.components.velSeam).toBeCloseTo(0, 6);
    expect(check.components.poseRMSTh).toBe(0.03);
    expect(check.components.maxJointTh).toBe(0.08);
    expect(check.components.rootDispTh).toBe(0.05);
    expect(check.components.headingDiffTh).toBe(10);
    expect(check.components.velSeamTh).toBe(0.1);
  });

  it('bestLoopRange 找到近零分循环区间；digest 透传同一 loopCheck', () => {
    const { summary, digest } = result;
    const range = summary.loopCheck!.bestLoopRange!;
    expect(range).not.toBeNull();
    // 最小分被周期对 (i, i+15) 与速度 cos 对称对簇共享，具体帧由浮点噪声决定——只断言分数
    expect(range.score).toBeLessThan(1e-3);
    expect(digest.loopCheck).toBe(summary.loopCheck);
  });

  it('facts：循环句（A.12 模板 + verdict 释义）与全片子句', () => {
    const { summary } = result;
    // 接触翻转把片子成 2 段 → facts = 2 段句 + 循环句 + 全片句（A.12 顺序：段 → 循环 → 全片）
    expect(summary.facts.some((fact) => fact.startsWith('循环检测：loop-perfect——'))).toBe(true);
    expect(summary.facts.some((fact) => fact.includes('；可无缝循环'))).toBe(true);
    expect(summary.facts.some((fact) => fact.includes('；循环 loop-perfect'))).toBe(true);
  });
});

describe('M6c · root-motion 步伐循环 strict（return-only；bestLoopRange = null）', () => {
  const result = run(buildLoopPoseOnlyClip(buildHumanoidRig()));

  it('verdict return-only：姿势归位（P 剥离位移）、位置漂移 1.0H、速度 seam ≈ 0.756', () => {
    const check = result.summary.loopCheck!;
    expect(check.verdict).toBe('return-only');
    expect(check.poseMatch).toBe(true);
    expect(check.positionMatch).toBe(false);
    // velSeam = 12 随动关节 × 梯形首末斜率反号：12×(2×(0.25/7)×15)/17 ≈ 0.756 ≥ 0.1
    expect(check.velocityMatch).toBe(false);
    expect(check.components.poseRMS).toBeCloseTo(0, 6);
    expect(check.components.rootDisp).toBeCloseTo(1.0, 6);
    expect(check.components.headingDiff).toBeCloseTo(0, 6);
    expect(check.components.velSeam).toBeCloseTo((12 * (2 * (0.25 / 7) * 15)) / 17, 3);
  });

  it('strict bestLoopRange = null（rootDisp/0.05 ≥ 5.3 > 1.5）；无 loop-seam 关键帧', () => {
    const { summary } = result;
    expect(summary.loopCheck!.bestLoopRange).toBeNull();
    expect(summary.keyframes.some((entry) => entry.reason === 'loop-seam')).toBe(false);
  });

  it('worstJoints：全身差为 0（残差仅骨骼链矩阵加法的浮点噪声）', () => {
    const check = result.summary.loopCheck!;
    expect(check.worstJoints).toHaveLength(3);
    expect(check.worstJoints.every((joint) => Math.abs(joint.diff) < 1e-9)).toBe(true);
  });
});

describe('M6c · root-motion 步伐循环 + loopMode pose-only（A.10）', () => {
  const result = run(buildLoopPoseOnlyClip(buildHumanoidRig()), { loopMode: 'pose-only' });

  it('verdict 不受 loopMode 影响（恒 strict 口径）：仍 return-only', () => {
    expect(result.summary.loopCheck!.verdict).toBe('return-only');
  });

  it('bestLoopRange 找到循环体：周期帧对（j−i = 15 采样帧）、score ≈ 0', () => {
    const range = result.summary.loopCheck!.bestLoopRange!;
    expect(range.frameEnd - range.frameStart).toBe(15); // 摆动周期 1s = 15 采样帧
    expect(range.score).toBeLessThan(1e-3);
    expect(range.components.poseRMS).toBeCloseTo(0, 6);
    expect(range.components.velSeam).toBeCloseTo(0, 6);
  });
});

describe('M6c · root-motion 步伐循环 4s + loopMode pose-only（loop-seam 关键帧）', () => {
  // 2s 短片的能量峰 / 幅度峰与 loop-seam 帧距 < 0.3s，被 A.11 去重挤掉；4s 片帧距拉开，
  // loop-seam 两帧（bestLoopRange i/j ×30fps 口径）得以进关键帧——验收「keyframes 含 loop-seam」。
  const result = run(buildLoopPoseOnlyClip(buildHumanoidRig(), { duration: 4 }), { loopMode: 'pose-only' });

  it('bestLoopRange 为整周期帧对（j−i 为 15 采样帧的倍数）、score = 0', () => {
    const range = result.summary.loopCheck!.bestLoopRange!;
    expect(range.frameEnd - range.frameStart).toBeGreaterThan(0);
    expect((range.frameEnd - range.frameStart) % 15).toBe(0); // 姿势逐位相同的帧对必为整周期
    expect(range.score).toBeLessThan(1e-3);
  });

  it('keyframes 含 loop-seam（A.11 优先级 4，两帧 = bestLoopRange i/j）', () => {
    const { summary } = result;
    const range = summary.loopCheck!.bestLoopRange!;
    const seamFrames = summary.keyframes.filter((entry) => entry.reason === 'loop-seam');
    expect(seamFrames.length).toBeGreaterThan(0);
    // loop-seam 帧号 = bestLoopRange 采样帧 × 2（30fps 口径）
    for (const entry of seamFrames) {
      expect([range.frameStart * 2, range.frameEnd * 2]).toContain(entry.frame);
    }
  });
});

describe('M6c · 顿挫循环（loop-pose-only：姿势与位置回起点、速度断裂）', () => {
  const result = run(buildLoopJerkClip(buildHumanoidRig()));

  it('verdict loop-pose-only：pose ∧ position ∧ ¬velocity；velSeam = 0.18', () => {
    const check = result.summary.loopCheck!;
    expect(check.verdict).toBe('loop-pose-only');
    expect(check.poseMatch).toBe(true);
    expect(check.positionMatch).toBe(true);
    expect(check.velocityMatch).toBe(false);
    expect(check.components.poseRMS).toBeCloseTo(0, 6);
    expect(check.components.rootDisp).toBeCloseTo(0, 6);
    // z 梯形往返：首末斜率反号 ±(0.75×0.06)/0.5 = ±0.09 H/s（17 关节刚体随动）→ 0.18
    expect(check.components.velSeam).toBeCloseTo(2 * ((0.75 * 0.06) / 0.5), 3);
  });

  it('facts 循环句为 loop-pose-only 释义；bestLoopRange 过线并进关键帧（loop-seam）', () => {
    const { summary } = result;
    expect(summary.facts.some((fact) => fact.startsWith('循环检测：loop-pose-only——'))).toBe(true);
    expect(summary.facts.some((fact) => fact.includes('循环会有顿挫'))).toBe(true);
    // 片内姿势逐帧近似同姿（P 剥离 hips 平移），内部存在 score < 1.5 的可循环区间
    const range = summary.loopCheck!.bestLoopRange!;
    expect(range).not.toBeNull();
    expect(range.score).toBeLessThan(1.5);
    expect(summary.keyframes.some((entry) => entry.reason === 'loop-seam')).toBe(true);
  });
});

describe('M6c · 不归位（no-return：crouch 后保持，姿态本体不回起点）', () => {
  const result = run(buildNoReturnClip(buildHumanoidRig()));

  it('verdict no-return；poseRMS/maxJoint 与 0.7 rad 前倾的 trig 已知答案一致', () => {
    const check = result.summary.loopCheck!;
    expect(check.verdict).toBe('no-return');
    expect(check.poseMatch).toBe(false);
    const c = Math.cos(0.7);
    const s = Math.sin(0.7);
    const dHead = Math.hypot(0.25 * s, 0.25 * (1 - c));
    const dArm = Math.hypot(0.18 * s, 0.18 * (1 - c));
    const dHand = Math.hypot(0.15 * s, 0.15 * (1 - c));
    const rms = Math.sqrt((dHead ** 2 + 2 * dArm ** 2 + 2 * dHand ** 2) / 17);
    expect(check.components.poseRMS).toBeCloseTo(rms, 6);
    expect(check.components.maxJoint).toBeCloseTo(dHead, 6);
  });

  it('worstJoints top3 = head, L.UpperArm, R.UpperArm（并列保持关节序，带差值）', () => {
    const check = result.summary.loopCheck!;
    expect(check.worstJoints.map((joint) => joint.id)).toEqual(['head', 'L.UpperArm', 'R.UpperArm']);
    const s = Math.sin(0.7);
    const c = Math.cos(0.7);
    expect(check.worstJoints[0]!.diff).toBeCloseTo(Math.hypot(0.25 * s, 0.25 * (1 - c)), 6);
    expect(check.worstJoints[1]!.diff).toBeCloseTo(Math.hypot(0.18 * s, 0.18 * (1 - c)), 6);
    expect(check.worstJoints[2]!.diff).toBeCloseTo(Math.hypot(0.18 * s, 0.18 * (1 - c)), 6);
  });

  it('速度 seam：首帧下蹲刚体速度 0.15/0.5 = 0.3 H/s、端点静止 → velSeam = 0.3', () => {
    const check = result.summary.loopCheck!;
    expect(check.components.velSeam).toBeCloseTo(0.15 / 0.5, 3);
  });

  it('facts 循环句为 no-return 释义', () => {
    expect(result.summary.facts.some((fact) => fact.startsWith('循环检测：no-return——'))).toBe(true);
    expect(result.summary.facts.some((fact) => fact.includes('不归位'))).toBe(true);
  });
});
