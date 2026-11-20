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

/**
 * 小角度匀速偏航（回归：P(t)「转 −heading」的符号）：身体姿态恒定、hips 缓慢偏航 degrees 度。
 * headingDiff = degrees < 10° 阈值时姿势判定应完全剥离朝向（poseRMS ≈ 0）；
 * 符号反了会把残留旋转放大一倍（P 多转 2×degrees），poseMatch 被误杀成 no-return。
 */
export function buildYawDriftClip(
  rig: HumanoidRig,
  options: { degrees?: number; duration?: number } = {},
): THREE.AnimationClip {
  const degrees = options.degrees ?? 8;
  const duration = options.duration ?? 2;
  const quat = new THREE.Quaternion();
  quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (degrees * Math.PI) / 180);
  return new THREE.AnimationClip('YawDrift', duration, [
    new THREE.QuaternionKeyframeTrack(
      'Hips.quaternion',
      [0, duration],
      [0, 0, 0, 1, quat.x, quat.y, quat.z, quat.w],
    ),
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

// ———————— M6b：分段 / guess 决策表的已知答案动画 ————————

/**
 * 跳跃（纯垂直）：0.5s 起跳、0.95s 到顶 +0.4、1.4s 落地，全身随动。
 * 顶点垂直速度归零 → Ê 在顶点形成显著能量谷（A.7 切分）→ 飞行拆成上升/下落两段，
 * guess 分别为 jump（hips 峰值升高 ≥0.05H）与 fall（未升高）——这是决策表的确定性行为。
 * 已知答案：liftoff frame 16、touchdown frame 44（30fps 口径）、airTime = 14/15 s、
 * maxRootYGain ≈ 0.385 H、分段 [gesture(起跳过渡), airborne(jump), airborne(fall), idle]。
 */
export function buildJumpClip(rig: HumanoidRig, options: { duration?: number } = {}): THREE.AnimationClip {
  const duration = options.duration ?? 2;
  const hipsLocal = rig.bones.Hips.position;
  const times = [0, 0.5, 0.95, 1.4, duration];
  const values: number[] = [];
  for (const t of times) {
    const u = t <= 0.5 || t >= 1.4 ? 0 : t < 0.95 ? 0.4 * ((t - 0.5) / 0.45) : 0.4 * ((1.4 - t) / 0.45);
    values.push(hipsLocal.x, hipsLocal.y + u, hipsLocal.z);
  }
  return new THREE.AnimationClip('Jump', duration, [
    new THREE.VectorKeyframeTrack('Hips.position', times, values),
  ]);
}

/**
 * 出拳：idle → windup 后拉（0.3–0.55s）→ 刀位停顿（0.55–0.85，≥0.25s 保证平滑后仍有能量谷）→
 * 高速前刺（0.85–1.15s，手/前臂/上臂局部 13.33/10.67/8 H/s，世界速度 32/18.67/8，
 * 峰值能量 ≈ 5.29 ≥ 2.0）→ 顶点停顿（1.15–1.45）→ 慢收（1.45–2.35）→ 尾段静止。
 * 注意 FK 层级：手臂关节世界速度 = 父链速度之和。
 * 已知答案（分段 guess 序列）：[gesture, strike-punch, recover]。
 */
export function buildPunchClip(rig: HumanoidRig, options: { duration?: number } = {}): THREE.AnimationClip {
  const duration = options.duration ?? 2.65;
  const times = [0, 0.3, 0.55, 0.85, 1.15, 1.45, 2.35, duration];
  const chains: Array<[string, number]> = [
    ['RightHand', 1],
    ['RightForeArm', 0.8],
    ['RightArm', 0.6],
  ];
  const tracks = chains.map(([bone, ratio]) => {
    const bone0 = rig.bones[bone]!;
    const offsets = [0, 0, -0.5, -0.5, 3.5, 3.5, 0, 0];
    const values: number[] = [];
    for (const offset of offsets) values.push(bone0.position.x, bone0.position.y, bone0.position.z + offset * ratio);
    return new THREE.VectorKeyframeTrack(`${bone}.position`, times, values);
  });
  return new THREE.AnimationClip('Punch', duration, tracks);
}

/**
 * 倒退走：hips 以 0.5 H/s 沿 −z 平移，双脚用局部轨道保持世界位置（踩地不腾空）。
 * 已知答案：单段 contact-move / guess backpedal、moveDirBody = back、rootSpeed 0.5、
 * 支撑 double-support、能量 ≈ 0.413 H/s（9.5 权重 × 0.5 / 11.5）。
 */
export function buildBackpedalClip(rig: HumanoidRig, options: { duration?: number; speed?: number } = {}): THREE.AnimationClip {
  const duration = options.duration ?? 2;
  const speed = options.speed ?? 0.5;
  const hipsLocal = rig.bones.Hips.position;
  const tracks: THREE.KeyframeTrack[] = [
    new THREE.VectorKeyframeTrack('Hips.position', [0, duration], [
      hipsLocal.x,
      hipsLocal.y,
      hipsLocal.z,
      hipsLocal.x,
      hipsLocal.y,
      hipsLocal.z - speed * duration,
    ]),
  ];
  for (const side of ['Left', 'Right'] as const) {
    const foot = rig.bones[`${side}Foot`]!;
    tracks.push(
      new THREE.VectorKeyframeTrack(`${side}Foot.position`, [0, duration], [
        foot.position.x,
        foot.position.y,
        foot.position.z,
        foot.position.x,
        foot.position.y,
        foot.position.z + speed * duration,
      ]),
    );
  }
  return new THREE.AnimationClip('Backpedal', duration, tracks);
}

/**
 * 侧移（向右 strafe-r）：hips 以 0.6 H/s 沿 +x 平移（角色右侧 = +x），双脚保持世界位置。
 * 已知答案：单段 contact-move / guess strafe-r、moveDirBody = right、能量 ≈ 0.496 H/s。
 */
export function buildStrafeClip(rig: HumanoidRig, options: { duration?: number; speed?: number } = {}): THREE.AnimationClip {
  const duration = options.duration ?? 2;
  const speed = options.speed ?? 0.6;
  const hipsLocal = rig.bones.Hips.position;
  const tracks: THREE.KeyframeTrack[] = [
    new THREE.VectorKeyframeTrack('Hips.position', [0, duration], [
      hipsLocal.x,
      hipsLocal.y,
      hipsLocal.z,
      hipsLocal.x + speed * duration,
      hipsLocal.y,
      hipsLocal.z,
    ]),
  ];
  for (const side of ['Left', 'Right'] as const) {
    const foot = rig.bones[`${side}Foot`]!;
    tracks.push(
      new THREE.VectorKeyframeTrack(`${side}Foot.position`, [0, duration], [
        foot.position.x,
        foot.position.y,
        foot.position.z,
        foot.position.x - speed * duration,
        foot.position.y,
        foot.position.z,
      ]),
    );
  }
  return new THREE.AnimationClip('Strafe', duration, tracks);
}

// ———————— M6c：循环 / 归位检测的已知答案动画 ————————

/** 采样网格关键帧序列（t = k/fps，k = 0..duration·fps 含端点；网格求值精确命中关键帧） */
function gridKeys(duration: number, sampleFps = 15): number[] {
  return Array.from({ length: Math.round(duration * sampleFps) + 1 }, (_, k) => k / sampleFps);
}

/**
 * 完美循环：hips 垂直正弦恰好 2 个完整周期（period = duration/2），端点精确回起点。
 * 正弦的奇对称（sin(−x) = −sin x）使首帧与端点的单侧差分速度相等，且 P(t) 减 hips 位置
 * 后全身刚体平移被剥离 → seam 的 poseRMS/rootDisp/headingDiff/velSeam 全为 0（1e-14 级
 * 浮点噪声）→ loop-perfect。bestLoopRange 的最小分被「周期对 (i, i+15)」与「速度 cos
 * 对称对」簇共享，具体命中由 1e-14 级浮点噪声决定——只断言 score 远小于 1。
 */
export function buildLoopPerfectClip(
  rig: HumanoidRig,
  options: { duration?: number; amplitude?: number; periods?: number } = {},
): THREE.AnimationClip {
  const duration = options.duration ?? 2;
  const amplitude = options.amplitude ?? 0.15;
  const periods = options.periods ?? 2;
  const hipsLocal = rig.bones.Hips.position;
  const times = gridKeys(duration);
  const values: number[] = [];
  for (const t of times) {
    values.push(
      hipsLocal.x,
      hipsLocal.y + amplitude * Math.sin((2 * Math.PI * periods * t) / duration),
      hipsLocal.z,
    );
  }
  return new THREE.AnimationClip('LoopPerfect', duration, [
    new THREE.VectorKeyframeTrack('Hips.position', times, values),
  ]);
}

/**
 * root-motion 步伐循环：hips 以 0.5 H/s 线性前移（位置不归位），下腿 / 手臂做分段线性
 * 周期摆动（周期 15 采样帧 = 1s；梯形波：m = k mod 15，m ≤ 7 上升、其余下降）。
 * 取分段线性而非正弦：同一 m 的关键帧值逐位相同 → 相位对齐帧对的姿势/速度差严格为 0。
 * 只动下腿与手臂（LeftLeg/RightLeg/LeftArm/RightArm，随动 Foot/Toe/ForeArm/Hand）——
 * 上腿枢轴固定 → heading 恒 0，P(t) 旋转恒为恒等。
 * 已知答案（swing = 0.25）：seam poseRMS = 0、rootDisp = 1.0、headingDiff = 0、
 * velSeam = 12×(2×(swing/7)×f_s)/17 ≈ 0.756（12 个随动关节、梯形首末斜率反号）
 * → strict verdict = return-only（¬position 优先，velocityMatch=false 不改判）；
 * strict bestLoopRange = null（rootDisp/0.05 ≥ (8/15)×0.5/0.05 ≈ 5.3）；
 * loopMode pose-only 的最小分只在周期帧对（j−i = 15）取到（score ≈ 0）。
 */
export function buildLoopPoseOnlyClip(
  rig: HumanoidRig,
  options: { duration?: number; speed?: number; swing?: number } = {},
): THREE.AnimationClip {
  const duration = options.duration ?? 2;
  const speed = options.speed ?? 0.5;
  const swing = options.swing ?? 0.25;
  const periodSamples = 15; // 1s @15fps
  const hipsLocal = rig.bones.Hips.position;
  const swingAt = (k: number): number => {
    const m = ((k % periodSamples) + periodSamples) % periodSamples;
    const half = (periodSamples - 1) / 2;
    return m <= half ? (m * swing) / half : ((periodSamples - m) * swing) / half;
  };
  const times = gridKeys(duration);
  const chains: Array<[string, number]> = [
    ['LeftLeg', 1],
    ['RightLeg', -1],
    ['LeftArm', -1],
    ['RightArm', 1],
  ];
  const tracks = chains.map(([bone, sign]) => {
    const rest = rig.bones[bone]!.position;
    const values: number[] = [];
    for (let k = 0; k < times.length; k += 1) values.push(rest.x, rest.y, rest.z + sign * swingAt(k));
    return new THREE.VectorKeyframeTrack(`${bone}.position`, times, values);
  });
  tracks.push(
    new THREE.VectorKeyframeTrack('Hips.position', [0, duration], [
      hipsLocal.x,
      hipsLocal.y,
      hipsLocal.z,
      hipsLocal.x,
      hipsLocal.y,
      hipsLocal.z + speed * duration,
    ]),
  );
  return new THREE.AnimationClip('LoopPoseOnly', duration, tracks);
}

/**
 * 顿挫循环：hips 垂直正弦 2 个完整周期（同 perfect，姿势/位置端点归零）+ 前向 z 梯形往返
 * （0 → −depth/2·1.5 → −depth → … → 0，折点 [0, 0.5, 1, 1.5, duration]）。z 端点精确回 0，
 * 但首末 z 速度反号（±0.75×depth/0.5 = ±0.09 H/s，全身 17 关节刚体随动）→
 * velSeam = 2×0.09 = 0.18 ≥ 0.10 → loop-pose-only（姿势与位置回起点、速度断裂）。
 */
export function buildLoopJerkClip(
  rig: HumanoidRig,
  options: { duration?: number; amplitude?: number; periods?: number; depth?: number } = {},
): THREE.AnimationClip {
  const duration = options.duration ?? 2;
  const amplitude = options.amplitude ?? 0.15;
  const periods = options.periods ?? 2;
  const depth = options.depth ?? 0.06;
  const hipsLocal = rig.bones.Hips.position;
  const zTimes = [0, 0.5, 1, 1.5, duration];
  const zKeys = [0, (-0.75 * depth), -depth, -0.75 * depth, 0];
  const zOffsetAt = (t: number): number => {
    for (let i = 0; i < zTimes.length - 1; i += 1) {
      const t0 = zTimes[i]!;
      const t1 = zTimes[i + 1]!;
      if (t <= t1) {
        const w = (t - t0) / (t1 - t0);
        return zKeys[i]! + (zKeys[i + 1]! - zKeys[i]!) * w;
      }
    }
    return zKeys[zKeys.length - 1]!;
  };
  const times = gridKeys(duration);
  const values: number[] = [];
  for (const t of times) {
    values.push(
      hipsLocal.x,
      hipsLocal.y + amplitude * Math.sin((2 * Math.PI * periods * t) / duration),
      hipsLocal.z + zOffsetAt(t),
    );
  }
  return new THREE.AnimationClip('LoopJerk', duration, [
    new THREE.VectorKeyframeTrack('Hips.position', times, values),
  ]);
}

/**
 * 不归位（一次性动作）：hips 前 0.5s 下降 drop 并保持 + Spine 0.5–0.7s 前倾 pitch 弧度
 * 并保持。注意 P(t) 减 hips 位置——纯刚体下蹲平移对姿势描述子不可见，必须有姿态本体
 * 变化（躯干前倾带动 head/双臂/双手）；上腿枢轴不动 → heading 恒 0。
 * 已知答案（pitch = 0.7，‖P 差‖按关节手推）：head √((0.25s)² + 0.25(1−c)²)、
 * L/R.UpperArm √((0.18s)² + 0.18(1−c)²)、L/R.Hand √((0.15s)² + 0.15(1−c)²)、其余 0
 * → poseRMS ≈ 0.069 ≥ 0.03 → poseMatch=false → no-return；
 * 另：首帧单侧速度 = −drop/0.5 = −0.3 H/s（全身刚体）、端点 0 → velSeam = 0.3。
 */
export function buildNoReturnClip(
  rig: HumanoidRig,
  options: { duration?: number; drop?: number; pitch?: number } = {},
): THREE.AnimationClip {
  const duration = options.duration ?? 2;
  const drop = options.drop ?? 0.15;
  const pitch = options.pitch ?? 0.7;
  const hipsLocal = rig.bones.Hips.position;
  const hipsTrack = new THREE.VectorKeyframeTrack('Hips.position', [0, 0.5, duration], [
    hipsLocal.x,
    hipsLocal.y,
    hipsLocal.z,
    hipsLocal.x,
    hipsLocal.y - drop,
    hipsLocal.z,
    hipsLocal.x,
    hipsLocal.y - drop,
    hipsLocal.z,
  ]);
  const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
  const spineTrack = new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 0.5, 0.7, duration], [
    0, 0, 0, 1,
    0, 0, 0, 1,
    quat.x, quat.y, quat.z, quat.w,
    quat.x, quat.y, quat.z, quat.w,
  ]);
  return new THREE.AnimationClip('NoReturn', duration, [hipsTrack, spineTrack]);
}

// ———————— M6f：多 clip 的 glTF 文件样例（工具层批量 clip:"*" 用） ————————

const CUBE_POSITIONS = new Float32Array([
  -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
  -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
]);
const CUBE_INDICES = new Uint16Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 2, 6, 3, 6, 7,
]);

interface PackedGltfBuffer {
  sections: Array<{ offset: number; byteLength: number }>;
  dataUri: string;
  byteLength: number;
}

/** 各段 Float32/Uint16 按 4 字节对齐打包成一块 base64 data URI buffer（测试内存构造，不落盘） */
function packGltfBuffer(parts: Array<Float32Array | Uint16Array>): PackedGltfBuffer {
  const sections: Array<{ offset: number; byteLength: number }> = [];
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const part of parts) {
    const view = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    sections.push({ offset: cursor, byteLength: part.byteLength });
    chunks.push(view);
    cursor += part.byteLength;
    const padding = (4 - (cursor % 4)) % 4;
    if (padding !== 0) {
      chunks.push(new Uint8Array(padding));
      cursor += padding;
    }
  }
  const bytes = new Uint8Array(cursor);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const base64 = Buffer.from(bytes).toString('base64');
  return { sections, dataUri: `data:application/octet-stream;base64,${base64}`, byteLength: bytes.byteLength };
}

/**
 * 与 buildAnimatedCubeGltf 同构的最小 cube 场景，但带两个动画（同轨道键，输出不同）：
 * - Walk：rig 节点沿 +x 平移 0→2（净位移 → rootMotion）；
 * - Jump：rig 节点沿 +y 平移 0→1.5。
 * 供工具层 clip:"*" 批量测试：一次 analyze 出两个 clip 的 digest、中间文件按 <clip>/ 分桶。
 */
export function buildTwoClipCubeGltf(): Record<string, unknown> {
  const positions = CUBE_POSITIONS;
  const indices = CUBE_INDICES;
  const ibm = new Float32Array(32); // 2 个单位 MAT4（loader 只要 accessor 存在）
  for (let matrix = 0; matrix < 2; matrix += 1) ibm[matrix * 16] = 1;
  const times = new Float32Array([0, 0.5]);
  const walkTranslation = new Float32Array([0, 0, 0, 2, 0, 0]);
  const jumpTranslation = new Float32Array([0, 0, 0, 0, 1.5, 0]);

  const layout = packGltfBuffer([positions, indices, ibm, times, walkTranslation, jumpTranslation]);
  const [pos, idx, matrices, tArr, walk, jump] = layout.sections;

  return {
    asset: { version: '2.0', generator: 'kinemesh-fixtures' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0, 3] }],
    nodes: [
      { name: 'rig', children: [1] },
      { name: 'bone_a', children: [2] },
      { name: 'bone_b' },
      { name: 'cube', mesh: 0, skin: 0 },
    ],
    meshes: [
      {
        name: 'Body',
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }],
      },
    ],
    materials: [{ name: 'BodyMat', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.4, 1] } }],
    skins: [{ name: 'Armature', joints: [1, 2], inverseBindMatrices: 2 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'MAT4' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [0.5] },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3', min: [0, 0, 0], max: [2, 0, 0] },
      { bufferView: 5, componentType: 5126, count: 2, type: 'VEC3', min: [0, 0, 0], max: [0, 1.5, 0] },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: pos.offset, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: idx.offset, byteLength: idx.byteLength },
      { buffer: 0, byteOffset: matrices.offset, byteLength: matrices.byteLength },
      { buffer: 0, byteOffset: tArr.offset, byteLength: tArr.byteLength },
      { buffer: 0, byteOffset: walk.offset, byteLength: walk.byteLength },
      { buffer: 0, byteOffset: jump.offset, byteLength: jump.byteLength },
    ],
    buffers: [{ byteLength: layout.byteLength, uri: layout.dataUri }],
    animations: [
      {
        name: 'Walk',
        samplers: [{ input: 3, output: 4 }],
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
      },
      {
        name: 'Jump',
        samplers: [{ input: 3, output: 5 }],
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
      },
    ],
  };
}
