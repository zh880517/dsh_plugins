// M7d（B.7 非人形泛化通道）：四足（AS 构造/链位权重/贴地肢链接触/root→head 朝向/泛化口径 warning）
// 与蛇形（无贴地肢链：contact/airborne 不输出、support=n/a）。映射文件走 bone-map 的
// parseBonesFile + checkBonesAgainstSkeleton 正规链路（与工具层同口径，不造旁路）。
import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { analyzeClip } from '../../plugins/kinemesh/src/core/motion/analyze.js';
import { computeChannels } from '../../plugins/kinemesh/src/core/motion/channels.js';
import { sampleClip } from '../../plugins/kinemesh/src/core/motion/sample.js';
import { checkBonesAgainstSkeleton, parseBonesFile, type BonesMapping } from '../../plugins/kinemesh/src/core/analyze/bone-map.js';
import type { CanonicalScene } from '../../plugins/kinemesh/src/core/types.js';
import {
  buildQuadrupedRig,
  buildQuadrupedTrotClip,
  buildQuadrupedTurnClip,
  buildRigScene,
  buildSnakeRig,
  buildSnakeSlitherClip,
  type QuadrupedRig,
} from '../support/kinemesh-rig-fixtures.js';

const QUADRUPED_BONES_JSON = `{
  "_meta": { "archetype": "quadruped" },
  "root": "Body",
  "head": "Head",
  "spine": ["Spine_1"],
  "limbs": [
    { "role": "leg", "tag": "fl", "bones": ["Leg_FL_1", "Foot_FL"], "tip": "Foot_FL" },
    { "role": "leg", "tag": "fr", "bones": ["Leg_FR_1", "Foot_FR"], "tip": "Foot_FR" },
    { "role": "leg", "tag": "bl", "bones": ["Leg_BL_1", "Foot_BL"], "tip": "Foot_BL" },
    { "role": "leg", "tag": "br", "bones": ["Leg_BR_1", "Foot_BR"], "tip": "Foot_BR" },
    { "role": "tail", "tag": "tail", "bones": ["Tail_1", "Tail_2"], "tip": "Tail_2" }
  ]
}`;

const SNAKE_BONES_JSON = `{
  "_meta": { "archetype": "chain" },
  "root": "S0",
  "spine": ["S1", "S2", "S3", "S4"]
}`;

function mappingOf(rigRoot: THREE.Object3D, json: string): BonesMapping {
  const data = parseBonesFile(json, 'test-kinemesh-bones.json');
  const parentOf = new Map<string, string | null>();
  rigRoot.traverse((obj) => {
    parentOf.set(obj.name, obj.parent?.name ?? null);
  });
  return checkBonesAgainstSkeleton(data, 'test-kinemesh-bones.json', parentOf);
}

function runQuadruped(
  rig: QuadrupedRig,
  clip: THREE.AnimationClip,
  options: Parameters<typeof analyzeClip>[1] = {},
): ReturnType<typeof analyzeClip> {
  const scene: CanonicalScene = buildRigScene(rig.root, [clip]);
  return analyzeClip(scene, { ...options, boneMap: mappingOf(rig.root, QUADRUPED_BONES_JSON) });
}

describe('M7d · 四足 AS 构造与链位权重（B.7）', () => {
  const rig = buildQuadrupedRig();
  const result = runQuadruped(rig, buildQuadrupedTrotClip(rig));

  it('summary.archetype=quadruped、jointBasis=archetype:quadruped、rootJoint=Body', () => {
    expect(result.summary.archetype).toBe('quadruped');
    expect(result.summary.jointBasis.basis).toBe('archetype:quadruped');
    expect(result.summary.rootJoint).toBe('Body');
  });

  it('AS = root/head/spine + 每肢首/末（两节链）+ 尾；权重按链位（root .2 / head 1.0 / spine .3 / 首 .6 / 末 1.0）', () => {
    const joints = result.summary.jointBasis.joints.map((joint) => `${joint.id}=${joint.weight}`);
    expect(joints).toEqual([
      'root=0.2',
      'head=1',
      'spine=0.3',
      'fl:base=0.6',
      'fl:tip=1',
      'fr:base=0.6',
      'fr:tip=1',
      'bl:base=0.6',
      'bl:tip=1',
      'br:base=0.6',
      'br:tip=1',
      'tail:base=0.6',
      'tail:tip=1',
    ]);
    expect(result.summary.jointBasis.joints).toHaveLength(13);
  });

  it('warnings：泛化通道执行口径 + 阈值按人形校准声明（§7.2）', () => {
    const text = result.summary.warnings.join('\n');
    expect(text).toContain('非人形泛化通道（B.7）执行');
    expect(text).toContain('阈值按人形运动校准');
  });
});

describe('M7d · 四足贴地肢链接触（trot 对角步）', () => {
  const rig = buildQuadrupedRig();
  const result = runQuadruped(rig, buildQuadrupedTrotClip(rig, { duration: 2 }));
  const sample = sampleClip(buildRigScene(rig.root, [buildQuadrupedTrotClip(rig, { duration: 2 })]), {
    boneMap: mappingOf(rig.root, QUADRUPED_BONES_JSON),
  });
  const channels = computeChannels(sample);

  it('contactTags 只含四条腿 tag，对角步两种对角组合都出现；尾/头永不参与接触', () => {
    const seen = new Set<string>();
    for (const tags of channels.contactTags) for (const tag of tags.split('+').filter((t) => t !== '')) seen.add(tag);
    expect([...seen].sort()).toEqual(['bl', 'br', 'fl', 'fr']);
    // tags 按字母序拼接：fl+br 对角 = 'br+fl'，fr+bl 对角 = 'bl+fr'
    const values = new Set(channels.contactTags);
    expect(values.has('br+fl')).toBe(true);
    expect(values.has('bl+fr')).toBe(true);
    for (const tags of channels.contactTags) {
      for (const tag of tags.split('+')) expect(['', 'fl', 'fr', 'bl', 'br']).toContain(tag);
    }
  });

  it('接触与腾空判定正确：support 出现 double-support（对角双腿），不会整片 n/a', () => {
    const supports = new Set(channels.support);
    expect(supports.has('double-support')).toBe(true);
    expect(supports.has('n/a')).toBe(false);
  });

  it('P(t)/loopCheck 在 AS 上工作：正弦整数周期 → verdict loop-perfect', () => {
    expect(result.summary.loopCheck!.verdict).toBe('loop-perfect');
    expect(result.summary.loopCheck!.poseMatch).toBe(true);
  });
});

describe('M7d · 四足 heading 走 root→head 回退（B.7 ②）', () => {
  const rig = buildQuadrupedRig();
  const sample = sampleClip(buildRigScene(rig.root, [buildQuadrupedTurnClip(rig, { degrees: 90, duration: 1 })]), {
    boneMap: mappingOf(rig.root, QUADRUPED_BONES_JSON),
  });
  const channels = computeChannels(sample);

  it('匀速转 90°：heading 沿网格线性逼近（k=7 → 42°、末帧 k=14 → 84°=90×14/15）', () => {
    expect(channels.heading[0]).toBeCloseTo(0, 3);
    expect(channels.heading[7]).toBeCloseTo(42, 1);
    expect(channels.heading[channels.frameCount - 1]).toBeCloseTo(84, 1);
  });
});

describe('M7d · 蛇形（chain）：无贴地肢链', () => {
  const rig = buildSnakeRig();
  const scene = buildRigScene(rig.root, [buildSnakeSlitherClip(rig)]);
  const result = analyzeClip(scene, { boneMap: mappingOf(rig.root, SNAKE_BONES_JSON) });

  it('archetype=chain；AS = root + spine 中位骨；contactTags 全空、support=n/a、airborne 恒 false', () => {
    expect(result.summary.archetype).toBe('chain');
    const sample = sampleClip(scene, { boneMap: mappingOf(rig.root, SNAKE_BONES_JSON) });
    const channels = computeChannels(sample);
    expect(result.summary.jointBasis.joints.map((joint) => joint.id)).toEqual(['root', 'spine']);
    for (const tags of channels.contactTags) expect(tags).toBe('');
    for (const support of channels.support) expect(support).toBe('n/a');
    for (const air of channels.airborne) expect(air).toBe(false);
  });

  it('warnings：无贴地肢链声明 + 人形校准口径；能量通道正常（侧摆有能量）', () => {
    const text = result.summary.warnings.join('\n');
    expect(text).toContain('无贴地肢链');
    expect(text).toContain('阈值按人形运动校准');
    expect(result.summary.clipStats.energy.max).toBeGreaterThan(0);
  });
});
