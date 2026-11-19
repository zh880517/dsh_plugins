// kinemesh M6 的合成 rig / 动画样例（测试用）：内存构造 three 场景，不经过文件解析，
// 供 core/motion 直接采样。全部确定性、数值有解析解：
//  - 线性位移：匀速直线走 → 速度/能量/方向全程恒定，逐项对答案；
//  - 正弦摆动：单关节正弦 → 差分速度/能量/幅度有解析形状（含速度恰为 0 的特殊帧）；
//  - 720° 自转：恒角速整圈旋转 → heading 逐帧精确、turnTotal 累计 720° 而净差为 0；
//  - 链式 rig：非人形命名 → motion-top15 关节集回退。
// 人形命名采用 Mixamo 风格（Hips/Spine/LeftHand…），角色面朝 +Z：右侧 = +X，左侧 = −X。
import * as THREE from 'three';
import type { CanonicalScene } from '../../plugins/kinemesh/src/core/types.js';

export interface HumanoidRig {
  root: THREE.Group;
  bones: Record<string, THREE.Bone>;
  /** 静息世界坐标（与 restLocal 一致；测试断言用） */
  restWorld: Record<string, [number, number, number]>;
}

interface BoneSpec {
  name: string;
  parent: string | null;
  local: [number, number, number];
}

/** 局部位置表（父链全为平移，无旋转/缩放 → 世界坐标 = 父世界 + 局部） */
const RIG_BONES: BoneSpec[] = [
  { name: 'Hips', parent: null, local: [0, 0.55, 0] },
  { name: 'Spine', parent: 'Hips', local: [0, 0.15, 0] },
  { name: 'Head', parent: 'Spine', local: [0, 0.25, 0] },
  { name: 'LeftArm', parent: 'Spine', local: [-0.18, 0.18, 0] },
  { name: 'RightArm', parent: 'Spine', local: [0.18, 0.18, 0] },
  { name: 'LeftForeArm', parent: 'LeftArm', local: [-0.12, -0.18, 0] },
  { name: 'RightForeArm', parent: 'RightArm', local: [0.12, -0.18, 0] },
  { name: 'LeftHand', parent: 'LeftForeArm', local: [-0.04, -0.15, 0] },
  { name: 'RightHand', parent: 'RightForeArm', local: [0.04, -0.15, 0] },
  { name: 'LeftUpLeg', parent: 'Hips', local: [-0.1, -0.03, 0] },
  { name: 'RightUpLeg', parent: 'Hips', local: [0.1, -0.03, 0] },
  { name: 'LeftLeg', parent: 'LeftUpLeg', local: [0, -0.24, 0] },
  { name: 'RightLeg', parent: 'RightUpLeg', local: [0, -0.24, 0] },
  { name: 'LeftFoot', parent: 'LeftLeg', local: [0, -0.25, 0] },
  { name: 'RightFoot', parent: 'RightLeg', local: [0, -0.25, 0] },
  { name: 'LeftToeBase', parent: 'LeftFoot', local: [0, -0.02, 0.08] },
  { name: 'RightToeBase', parent: 'RightFoot', local: [0, -0.02, 0.08] },
];

export function buildHumanoidRig(): HumanoidRig {
  const root = new THREE.Group();
  root.name = 'rig';
  const bones: Record<string, THREE.Bone> = {};
  const restWorld: Record<string, [number, number, number]> = {};
  for (const spec of RIG_BONES) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bone.position.set(...spec.local);
    bones[spec.name] = bone;
    if (spec.parent === null) root.add(bone);
    else bones[spec.parent].add(bone);
  }
  root.updateMatrixWorld(true);
  for (const spec of RIG_BONES) {
    const world = new THREE.Vector3();
    bones[spec.name].getWorldPosition(world);
    restWorld[spec.name] = [world.x, world.y, world.z];
  }
  return { root, bones, restWorld };
}

/** 包成 CanonicalScene（格式标记只影响 meta 显示，不影响采样） */
export function buildRigScene(root: THREE.Object3D, clips: THREE.AnimationClip[]): CanonicalScene {
  return {
    object: root,
    animations: clips,
    meta: { format: 'glb', unitScaleFactor: null, upAxis: 'y', fps: null },
  };
}

/** 匀速直线走：hips 局部 z 从 0 线性推进 speed·duration，其余关节静止 */
export function buildLinearWalkClip(
  rig: HumanoidRig,
  options: { speed?: number; duration?: number } = {},
): THREE.AnimationClip {
  const speed = options.speed ?? 1;
  const duration = options.duration ?? 2;
  const hipsLocal = rig.bones.Hips.position;
  const values = [
    hipsLocal.x,
    hipsLocal.y,
    hipsLocal.z,
    hipsLocal.x,
    hipsLocal.y,
    hipsLocal.z + speed * duration,
  ];
  return new THREE.AnimationClip('Walk', duration, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, duration], values),
  ]);
}

/** 单关节正弦摆动：右手局部 x = rest + amplitude·sin(2π t/period)，关键帧落在采样网格上 */
export function buildSineSwingClip(
  rig: HumanoidRig,
  options: { amplitude?: number; period?: number; duration?: number; sampleFps?: number } = {},
): THREE.AnimationClip {
  const amplitude = options.amplitude ?? 0.3;
  const period = options.period ?? 4;
  const duration = options.duration ?? 4;
  const sampleFps = options.sampleFps ?? 15;
  const rest = rig.bones.RightHand.position;
  const keyCount = Math.round(duration * sampleFps);
  const times: number[] = [];
  const values: number[] = [];
  for (let k = 0; k <= keyCount; k += 1) {
    const t = k / sampleFps;
    times.push(t);
    values.push(rest.x + amplitude * Math.sin((2 * Math.PI * t) / period), rest.y, rest.z);
  }
  const track = new THREE.VectorKeyframeTrack('RightHand.position', times, values);
  return new THREE.AnimationClip('Swing', duration, [track]);
}

/** 恒角速自转：hips 每 90° 一个关键帧（quaternion slerp 恒角速、方向无歧义） */
export function buildSpinClip(
  rig: HumanoidRig,
  options: { totalDegrees?: number; duration?: number } = {},
): THREE.AnimationClip {
  const totalDegrees = options.totalDegrees ?? 720;
  const duration = options.duration ?? 4;
  const steps = Math.round(totalDegrees / 90);
  const times: number[] = [];
  const values: number[] = [];
  const quat = new THREE.Quaternion();
  for (let i = 0; i <= steps; i += 1) {
    times.push((duration * i) / steps);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (totalDegrees * Math.PI * i) / (180 * steps));
    values.push(quat.x, quat.y, quat.z, quat.w);
  }
  return new THREE.AnimationClip('Spin', duration, [
    new THREE.QuaternionKeyframeTrack('Hips.quaternion', times, values),
  ]);
}

// ———————— 非人形链式 rig（motion-top15 回退） ————————

export interface ChainRig {
  root: THREE.Group;
  bones: Record<string, THREE.Bone>;
}

export function buildChainRig(): ChainRig {
  const root = new THREE.Group();
  root.name = 'chain';
  const segA = new THREE.Bone();
  segA.name = 'seg_a';
  const segB = new THREE.Bone();
  segB.name = 'seg_b';
  segB.position.set(0, 0.5, 0);
  const segC = new THREE.Bone();
  segC.name = 'seg_c';
  segC.position.set(0, 0.5, 0);
  segA.add(segB);
  segB.add(segC);
  root.add(segA);
  root.updateMatrixWorld(true);
  return { root, bones: { seg_a: segA, seg_b: segB, seg_c: segC } };
}

/** seg_b 绕 Z 摆动 → seg_c 公转（世界位移方差最大者），seg_a/seg_b 原点静止 */
export function buildChainSwingClip(rig: ChainRig): THREE.AnimationClip {
  const times = [0, 0.5, 1, 1.5, 2];
  const quat = new THREE.Quaternion();
  const values: number[] = [];
  for (const t of times) {
    quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sin(Math.PI * t) * 0.6);
    values.push(quat.x, quat.y, quat.z, quat.w);
  }
  return new THREE.AnimationClip('ChainSwing', 2, [
    new THREE.QuaternionKeyframeTrack(`${rig.bones.seg_b.name}.quaternion`, times, values),
  ]);
}

/** 只有 morph 轨道的 clip（A.14 morph-only 拒绝路径） */
export function buildMorphOnlyClip(): THREE.AnimationClip {
  const track = new THREE.NumberKeyframeTrack('Hips.morphTargetInfluences', [0, 1], [0, 1]);
  return new THREE.AnimationClip('Blink', 1, [track]);
}
