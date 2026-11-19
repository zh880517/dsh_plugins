// M6a 采样器（附录 A.1）：关节集解析、采样网格与精确端点、rest 姿态恢复、
// 已知答案合成动画（线性位移 / 正弦摆动 / 720° 自转）的数值逐项对答案、拒绝路径。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { KinemeshError } from '../../plugins/kinemesh/src/core/errors.js';
import { sampleClip } from '../../plugins/kinemesh/src/core/motion/sample.js';
import {
  buildChainRig,
  buildChainSwingClip,
  buildHumanoidRig,
  buildLinearWalkClip,
  buildMorphOnlyClip,
  buildRigScene,
  buildSineSwingClip,
  buildSpinClip,
  type HumanoidRig,
} from '../support/kinemesh-rig-fixtures.js';

function sampleHumanoid(clip: THREE.AnimationClip, options?: Parameters<typeof sampleClip>[1]) {
  const rig = buildHumanoidRig();
  const sample = sampleClip(buildRigScene(rig.root, [clip]), options);
  return { rig, sample };
}

describe('sampleClip · 关节集解析（附录 A.0）', () => {
  it('人形惯例集：J15 + 双 Toe 全命中、hips 为 rootPos 参照、frames 按 30fps', () => {
    const rig = buildHumanoidRig();
    const sample = sampleClip(buildRigScene(rig.root, [buildLinearWalkClip(rig)]));
    expect(sample.jointBasis).toBe('humanoid-conventions');
    expect(sample.declaredJoints).toEqual([]);
    expect(sample.joints.map((joint) => joint.id)).toEqual([
      'hips',
      'spine',
      'head',
      'L.UpperArm',
      'R.UpperArm',
      'L.LowerArm',
      'R.LowerArm',
      'L.Hand',
      'R.Hand',
      'L.UpperLeg',
      'R.UpperLeg',
      'L.LowerLeg',
      'R.LowerLeg',
      'L.Foot',
      'R.Foot',
      'L.Toe',
      'R.Toe',
    ]);
    // 权重表（A.3）：Hand 1.2 / hips 0.2 / Toe 0
    expect(sample.joints[0].weight).toBe(0.2);
    expect(sample.joints[7].weight).toBe(1.2);
    expect(sample.joints[15].weight).toBe(0);
    expect(sample.anchors.hips).toBe(0);
    expect(sample.anchors.head).toBe(2);
    expect(sample.rootJoint?.name).toBe('Hips');
    // 帧号口径 frame = round(t×30)：duration 2s × 15fps → N=30，帧号 0,2,…,58
    expect(sample.frameCount).toBe(30);
    expect(sample.frames).toEqual(Array.from({ length: 30 }, (_, k) => k * 2));
    expect(sample.endpointTime).toBe(2);
  });

  it('非人形命名：回退 motion-top15，方差最大者排首，rootJoint 取最上骨骼', () => {
    const chain = buildChainRig();
    const sample = sampleClip(buildRigScene(chain.root, [buildChainSwingClip(chain)]));
    expect(sample.jointBasis).toBe('motion-top15');
    expect(sample.joints[0].id).toBe('seg_c');
    expect(sample.joints.map((joint) => joint.id)).toContain('seg_a');
    expect(sample.joints.every((joint) => joint.weight === 1)).toBe(true);
    expect(sample.rootJoint?.name).toBe('seg_a');
    expect(sample.warnings.some((warning) => warning.includes('motion-top15'))).toBe(true);
  });

  it('explicit joints：接受 J15 规范名，权重按惯例表；未知关节给三段式报错', () => {
    const rig = buildHumanoidRig();
    const scene = buildRigScene(rig.root, [buildLinearWalkClip(rig)]);
    const sample = sampleClip(scene, { joints: ['L.Hand', 'R.Hand'] });
    expect(sample.jointBasis).toBe('explicit');
    expect(sample.joints.map((joint) => joint.id)).toEqual(['L.Hand', 'R.Hand']);
    expect(sample.joints[0].weight).toBe(1.2);
    expect(() => sampleClip(scene, { joints: ['Nope'] })).toThrow(KinemeshError);
    try {
      sampleClip(scene, { joints: ['Nope'] });
      expect.unreachable();
    } catch (error) {
      expect((error as KinemeshError).message).toContain('Nope');
      expect((error as KinemeshError).guidance).toContain('kinemesh_info');
    }
  });
});

describe('sampleClip · 已知答案：线性位移', () => {
  it('匀速直线走：全部关节速度恒为 1 H/s，hips 线性推进，端点精确到 duration', () => {
    const { sample } = sampleHumanoid(buildLinearWalkClip(buildHumanoidRig(), { speed: 1, duration: 2 }));
    const hipsIndex = sample.anchors.hips;
    const zAt = (k: number): number => sample.positions[(k * sample.joints.length + hipsIndex) * 3 + 2];
    for (let k = 0; k < sample.frameCount; k += 1) {
      expect(zAt(k)).toBeCloseTo(k / 15, 4);
    }
    // 精确端点（虚拟点 k=N）：t=duration 恰为 2.0
    expect(sample.endpointPositions[hipsIndex * 3 + 2]).toBeCloseTo(2, 4);
    // 双 Toe 也在关节集里，跟随整体平移
    const toeBase = sample.joints.findIndex((joint) => joint.id === 'L.Toe');
    expect(sample.positions[(0 * sample.joints.length + toeBase) * 3]).toBeCloseTo(-0.1, 4);
    expect(sample.positions[(0 * sample.joints.length + toeBase) * 3 + 2]).toBeCloseTo(0.08, 4);
  });
});

describe('sampleClip · 已知答案：正弦摆动', () => {
  it('手部世界坐标在特殊帧取得解析值（峰值/起点/终点），端点回到 rest', () => {
    const { rig, sample } = sampleHumanoid(buildSineSwingClip(buildHumanoidRig()));
    const handIndex = sample.joints.findIndex((joint) => joint.id === 'R.Hand');
    const handX = (k: number): number => sample.positions[(k * sample.joints.length + handIndex) * 3];
    const rest = rig.restWorld.RightHand[0];
    // t=0：x = rest（sin 0）；t=1（k=15）：峰值 rest+0.3；t=2（k=30）：过零点 rest；t=4 端点：rest
    expect(handX(0)).toBeCloseTo(rest, 4);
    expect(handX(15)).toBeCloseTo(rest + 0.3, 4);
    expect(handX(30)).toBeCloseTo(rest, 4);
    expect(sample.endpointPositions[handIndex * 3]).toBeCloseTo(rest, 4);
  });
});

describe('sampleClip · 已知答案：720° 自转', () => {
  it('恒角速旋转：端点回到 rest（720°≡恒等），hips 位置不动', () => {
    const { rig, sample } = sampleHumanoid(buildSpinClip(buildHumanoidRig()));
    const handIndex = sample.joints.findIndex((joint) => joint.id === 'R.Hand');
    const rest = rig.restWorld.RightHand;
    // k=15（t=1s）转了 180°：位置绕轴镜像（x、z 分量取反，y 不变）
    const x15 = sample.positions[(15 * sample.joints.length + handIndex) * 3];
    const z15 = sample.positions[(15 * sample.joints.length + handIndex) * 3 + 2];
    expect(x15).toBeCloseTo(-rest[0], 4);
    expect(z15).toBeCloseTo(-rest[2], 4);
    // k=30（t=2s）转了 360° ≡ 恒等：位置回到 rest
    const x30 = sample.positions[(30 * sample.joints.length + handIndex) * 3];
    const z30 = sample.positions[(30 * sample.joints.length + handIndex) * 3 + 2];
    expect(x30).toBeCloseTo(rest[0], 4);
    expect(z30).toBeCloseTo(rest[2], 4);
    // 端点 720° ≡ 0°：世界坐标回到 rest
    expect(sample.endpointPositions[handIndex * 3]).toBeCloseTo(rest[0], 4);
    expect(sample.endpointPositions[handIndex * 3 + 2]).toBeCloseTo(rest[2], 4);
    // hips 在转轴上，全程不动
    const hipsIndex = sample.anchors.hips;
    expect(sample.positions[(45 * sample.joints.length + hipsIndex) * 3]).toBeCloseTo(0, 4);
  });
});

describe('sampleClip · rest 姿态恢复（附录 A.1 必经步骤）', () => {
  it('采样后局部 pose 与 matrixWorld 恢复 rest；同一场景重复采样结果一致', () => {
    const rig = buildHumanoidRig();
    const hipsRestPos = rig.bones.Hips.position.clone();
    const handRestPos = rig.bones.RightHand.position.clone();
    const hipsRestQuat = rig.bones.Hips.quaternion.clone();
    const scene = buildRigScene(rig.root, [buildSineSwingClip(rig), buildSpinClip(rig)]);
    const first = sampleClip(scene, { clipName: 'Swing' });
    const second = sampleClip(scene, { clipName: 'Swing' });
    // 被动画覆写过的属性恢复原值
    expect(rig.bones.RightHand.position.x).toBeCloseTo(handRestPos.x, 6);
    expect(rig.bones.RightHand.position.y).toBeCloseTo(handRestPos.y, 6);
    expect(rig.bones.Hips.position.equals(hipsRestPos)).toBe(true);
    expect(rig.bones.Hips.quaternion.angleTo(hipsRestQuat)).toBeLessThan(1e-9);
    // matrixWorld 缓存也恢复（后续 render / 面板复用不被污染）
    rig.root.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    rig.bones.RightHand.getWorldPosition(world);
    expect(world.x).toBeCloseTo(rig.restWorld.RightHand[0], 6);
    // 结果确定性
    expect(Array.from(first.positions)).toEqual(Array.from(second.positions));
  });
});

describe('sampleClip · 拒绝路径与提示（附录 A.14）', () => {
  it('无动画资产', () => {
    const rig = buildHumanoidRig();
    try {
      sampleClip(buildRigScene(rig.root, []));
      expect.unreachable();
    } catch (error) {
      expect((error as KinemeshError).message).toContain('没有动画片段');
    }
  });

  it('clip 缺失时列出现有片段', () => {
    const rig = buildHumanoidRig();
    try {
      sampleClip(buildRigScene(rig.root, [buildLinearWalkClip(rig)]), { clipName: 'Nope' });
      expect.unreachable();
    } catch (error) {
      expect((error as KinemeshError).message).toContain('「Nope」');
      expect((error as KinemeshError).guidance).toContain('「Walk」');
    }
  });

  it('片段过短（N < 3）', () => {
    const rig = buildHumanoidRig();
    const tiny = new THREE.AnimationClip('Tiny', 0.1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 0.1], [0, 0.55, 0, 0, 0.55, 0.1]),
    ]);
    try {
      sampleClip(buildRigScene(rig.root, [tiny]));
      expect.unreachable();
    } catch (error) {
      expect((error as KinemeshError).message).toContain('片段过短');
      expect((error as KinemeshError).guidance).toContain('sampleFps');
    }
  });

  it('采样点超上限（duration × sampleFps > 24000）', () => {
    const rig = buildHumanoidRig();
    const long = new THREE.AnimationClip('Long', 1601, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1601], [0, 0.55, 0, 0, 0.55, 1]),
    ]);
    try {
      sampleClip(buildRigScene(rig.root, [long]));
      expect.unreachable();
    } catch (error) {
      expect((error as KinemeshError).message).toContain('采样点过多');
      expect((error as KinemeshError).guidance).toContain('sampleFps');
    }
  });

  it('sampleFps 越界（1–60）', () => {
    const rig = buildHumanoidRig();
    const scene = buildRigScene(rig.root, [buildLinearWalkClip(rig)]);
    for (const sampleFps of [0, 61]) {
      try {
        sampleClip(scene, { sampleFps });
        expect.unreachable();
      } catch (error) {
        expect((error as KinemeshError).message).toContain('sampleFps');
      }
    }
  });

  it('morph-only 动画：拒绝并指路 kinemesh_render', () => {
    const rig = buildHumanoidRig();
    try {
      sampleClip(buildRigScene(rig.root, [buildMorphOnlyClip()]));
      expect.unreachable();
    } catch (error) {
      expect((error as KinemeshError).message).toContain('形态动画');
      expect((error as KinemeshError).guidance).toContain('kinemesh_render');
    }
  });

  it('骨骼 + morph 混合：正常分析并提示忽略条数', () => {
    const rig = buildHumanoidRig();
    const clip = buildLinearWalkClip(rig);
    clip.tracks.push(new THREE.NumberKeyframeTrack('Hips.morphTargetInfluences', [0, 1], [0, 1]));
    const { sample } = sampleHumanoid(clip);
    expect(sample.frameCount).toBe(30);
    expect(sample.warnings.some((warning) => warning.includes('morph/blend shape'))).toBe(true);
  });
});
