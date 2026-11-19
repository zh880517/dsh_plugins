// headless 采样（design.md 附录 A.1）：AnimationClip 逐 track evaluate → 局部姿态
// → updateMatrixWorld(true) → 世界关节点矩阵。场景来自进程内缓存（M6f 接线），
// 被 analyze / render / 面板复用——因此采样前快照全部节点 rest 姿态、结束后必须恢复。
// 采样网格 t_k = kΔt（k = 0..N−1）；另对 t = duration 精确评估一次（虚拟点 k=N，
// 仅用于 seam 分量与「端点」关键帧，见附录 A.0/A.10）。
import * as THREE from 'three';
import { KinemeshError } from '../errors.js';
import {
  classifyJointName,
  isHumanoidLike,
  type JointKind,
} from '../analyze/humanoid.js';
import type { CanonicalScene } from '../types.js';
import {
  JOINT_WEIGHTS,
  SAMPLE_COUNT_MAX,
  SAMPLE_FPS_DEFAULT,
  SAMPLE_FPS_MAX,
  SAMPLE_FPS_MIN,
} from './constants.js';
import { RENDER_FPS } from '../viewstate.js';

/** 关节集解析口径（附录 A.0） */
export type JointBasis = 'humanoid-conventions' | 'motion-top15' | 'explicit';

export interface SampledJoint {
  /** 规范 id：J15 用 hips/spine/head/L.Hand…；top15 与 explicit-骨骼名用场景对象名 */
  id: string;
  /** 场景对象名（ kinemesh_info 的 bones 同名，便于回查） */
  objectName: string;
  /** 能量权重（附录 A.3 权重表）；0 = 只作足点/参照，不进能量与 Σw */
  weight: number;
}

export interface SampleAnchors {
  /** 以下均为 joints 数组下标；-1 = 缺失 */
  hips: number;
  head: number;
  leftUpperLeg: number;
  rightUpperLeg: number;
  /** 幅度端点（附录 A.3：L/R Hand、L/R Foot、head） */
  endEffectors: number[];
  /** 接触检测足点（附录 A.6：每脚 {Foot, Toe?}） */
  footPoints: Array<{ side: 'L' | 'R'; index: number }>;
}

/** rootPos / heading 回退的参照对象逐帧轨迹（附录 A.4/A.5） */
export interface SampleRootTrack {
  /** 世界坐标（模型单位）N×3；末尾 endpointPosition 是 t=duration 的 3 值 */
  positions: Float64Array;
  /** 世界四元数 N×4；末尾 endpointQuaternion 是 t=duration 的 4 值 */
  quaternions: Float64Array;
  endpointPosition: Float64Array;
  endpointQuaternion: Float64Array;
}

export interface SampleResult {
  clipName: string;
  /** 秒 */
  duration: number;
  sampleFps: number;
  dt: number;
  /** N = ceil(duration·f_s)；采样网格帧数（虚拟端点 k=N 不含在内） */
  frameCount: number;
  /** t_k = k/f_s（k = 0..N−1），秒 */
  times: number[];
  /** frame(t) = round(t×30)，与 kinemesh_render 同口径（RENDER_FPS） */
  frames: number[];
  /** t = duration 精确端点评估的时间与关节坐标 */
  endpointTime: number;
  /** 世界坐标（模型单位）N×J×3，joints 顺序 */
  positions: Float64Array;
  endpointPositions: Float64Array;
  jointBasis: JointBasis;
  joints: SampledJoint[];
  jointObjects: THREE.Object3D[];
  anchors: SampleAnchors;
  /** rootPos 参照（hips / top15 最上骨骼 / explicit-hips）；null = 无（rootPos/heading 记 0） */
  rootJoint: THREE.Object3D | null;
  rootTrack: SampleRootTrack | null;
  /** J15 惯例集里没匹配到的 id（humanoid 基准时进 summary.jointBasis 说明口径） */
  declaredJoints: string[];
  /** 非致命提示：忽略的 morph 轨道、未绑定成功的轨道 */
  warnings: string[];
  /** range 切片（M6f）：本次采样实际覆盖的 [t0, t1]（t1 夹到时长）；未切片时缺省 */
  range?: [number, number];
}

export interface SampleOptions {
  /** 缺省取第一个 clip（§6.7） */
  clipName?: string;
  /** 1–60，缺省 SAMPLE_FPS_DEFAULT */
  sampleFps?: number;
  /** 'auto'（缺省）或关节 id / 骨骼名清单（§6.7 joints 参数） */
  joints?: 'auto' | string[];
  /** [t0, t1] 秒切片（M6f §6.7）：只采样全片网格上 t∈[t0,t1] 的点；帧号仍按全片口径（t 不重置） */
  range?: [number, number];
}

// ———————— J15 + Toe 解析计划（附录 A.0 顺序即输出顺序） ————————

interface J15SlotPlan {
  id: string;
  kind: JointKind;
  side: 'L' | 'R' | null;
}

const J15_PLAN: J15SlotPlan[] = [
  { id: 'hips', kind: 'hips', side: null },
  { id: 'spine', kind: 'spine', side: null },
  { id: 'head', kind: 'head', side: null },
  { id: 'L.UpperArm', kind: 'upper-arm', side: 'L' },
  { id: 'R.UpperArm', kind: 'upper-arm', side: 'R' },
  { id: 'L.LowerArm', kind: 'lower-arm', side: 'L' },
  { id: 'R.LowerArm', kind: 'lower-arm', side: 'R' },
  { id: 'L.Hand', kind: 'hand', side: 'L' },
  { id: 'R.Hand', kind: 'hand', side: 'R' },
  { id: 'L.UpperLeg', kind: 'upper-leg', side: 'L' },
  { id: 'R.UpperLeg', kind: 'upper-leg', side: 'R' },
  { id: 'L.LowerLeg', kind: 'lower-leg', side: 'L' },
  { id: 'R.LowerLeg', kind: 'lower-leg', side: 'R' },
  { id: 'L.Foot', kind: 'foot', side: 'L' },
  { id: 'R.Foot', kind: 'foot', side: 'R' },
];

const TOE_PLAN: Array<{ id: string; side: 'L' | 'R' }> = [
  { id: 'L.Toe', side: 'L' },
  { id: 'R.Toe', side: 'R' },
];

interface RestSnapshot {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

/**
 * @types/three 未声明运行时存在的两个动画系统方法（three r187 源码已核对）：
 * - KeyframeTrack.createInterpolant()：为轨道预构建插值器（A.1 第 2 步）；
 * - PropertyBinding.setValue(buffer, offset)：把插值结果写回目标属性（首次调用自绑定）。
 */
interface TrackInterpolant {
  evaluate(time: number): ArrayLike<number>;
}

type AnimatableTrack = THREE.KeyframeTrack & { createInterpolant(): TrackInterpolant };

type WritableBinding = THREE.PropertyBinding & {
  setValue(sourceArray: ArrayLike<number>, offset: number): void;
};

interface PreparedTrack {
  binding: WritableBinding;
  interpolant: TrackInterpolant;
}

interface PreparedClips {
  bindings: PreparedTrack[];
  morphIgnored: number;
  unresolved: string[];
}

function snapshotRestPose(root: THREE.Object3D): Map<THREE.Object3D, RestSnapshot> {
  const snapshot = new Map<THREE.Object3D, RestSnapshot>();
  root.traverse((obj) => {
    snapshot.set(obj, {
      position: obj.position.clone(),
      quaternion: obj.quaternion.clone(),
      scale: obj.scale.clone(),
    });
  });
  return snapshot;
}

function restoreRestPose(root: THREE.Object3D, snapshot: Map<THREE.Object3D, RestSnapshot>): void {
  for (const [obj, rest] of snapshot) {
    obj.position.copy(rest.position);
    obj.quaternion.copy(rest.quaternion);
    obj.scale.copy(rest.scale);
  }
  root.updateMatrixWorld(true);
}

function pickClip(scene: CanonicalScene, clipName: string | undefined): THREE.AnimationClip {
  const clips = scene.animations;
  if (clips.length === 0) {
    throw new KinemeshError(
      '没有动画片段：该资产没有可分析的动画。',
      '先用 kinemesh_info 确认 clips 列表；静态资产没有动作可分析，改用 kinemesh_info / kinemesh_render。',
    );
  }
  if (clipName === undefined || clipName === '') return clips[0]!;
  const found = clips.find((clip) => clip.name === clipName);
  if (found) return found;
  const names = clips.map((clip) => `「${clip.name}」`).join('、');
  throw new KinemeshError(
    `找不到动画片段「${clipName}」。`,
    `该资产的动画片段：${names}。改用其中之一的名称，或省略 clip 参数取第一个。`,
  );
}

/** 轨道准备（附录 A.1 第 2 步 + A.14 morph 口径） */
function prepareTracks(root: THREE.Object3D, clip: THREE.AnimationClip): PreparedClips {
  const morphIgnored = clip.tracks.filter((track) => /\.morphTargetInfluences/.test(track.name)).length;
  const transformTracks = clip.tracks.filter((track) => !/\.morphTargetInfluences/.test(track.name));
  if (clip.tracks.length === 0) {
    throw new KinemeshError(
      `动画片段「${clip.name}」没有任何动画轨道。`,
      '该 clip 是空片段；先用 kinemesh_info 确认 clips 列表，换一个有轨道的 clip。',
    );
  }
  if (transformTracks.length === 0) {
    throw new KinemeshError(
      `形态动画：片段「${clip.name}」只有 ${morphIgnored} 条 morph/blend shape 轨道，无骨骼轨道，骨骼运动分析不适用。`,
      '这是表情/口型类动画；改用 kinemesh_render 指定帧号逐帧查看，或换有骨骼动画的 clip。',
    );
  }
  const bindings: PreparedTrack[] = [];
  const unresolved: string[] = [];
  for (const track of transformTracks) {
    const binding = new THREE.PropertyBinding(root, track.name) as WritableBinding;
    if (binding.node == null) {
      unresolved.push(track.name);
      continue;
    }
    bindings.push({ binding, interpolant: (track as AnimatableTrack).createInterpolant() });
  }
  return { bindings, morphIgnored, unresolved };
}

function resolveSampleFps(sampleFps: number | undefined): number {
  if (sampleFps === undefined) return SAMPLE_FPS_DEFAULT;
  if (!Number.isFinite(sampleFps) || sampleFps < SAMPLE_FPS_MIN || sampleFps > SAMPLE_FPS_MAX) {
    throw new KinemeshError(
      `sampleFps 超出范围（${SAMPLE_FPS_MIN}–${SAMPLE_FPS_MAX}）：${sampleFps}。`,
      `把 sampleFps 放回 ${SAMPLE_FPS_MIN}–${SAMPLE_FPS_MAX}（缺省 ${SAMPLE_FPS_DEFAULT}）。`,
    );
  }
  return sampleFps;
}

/** 采样网格对齐容差：t0·f_s / t1·f_s 落在整数码头上时不受浮点噪声影响 */
const RANGE_GRID_EPS = 1e-9;

/**
 * range 切片校验（M6f §6.7）：0 ≤ t0 < t1 ≤ duration；t1 越界的容差 = 网格容差。
 * 校验不通过给三段式（口径同 A.14 拒绝路径）；通过时返回夹好的 [t0, t1]。
 */
function resolveRange(range: [number, number] | undefined, clipName: string, duration: number): [number, number] | null {
  if (range === undefined) return null;
  const [t0, t1] = range;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t0 >= t1) {
    throw new KinemeshError(
      `range 参数不合法：[${t0}, ${t1}]。`,
      `range 是 [t0, t1] 秒数组，要求 0 ≤ t0 < t1 ≤ 片段时长；先用 kinemesh_info 查 clips[].duration 再给 range。`,
    );
  }
  if (t1 > duration + RANGE_GRID_EPS) {
    throw new KinemeshError(
      `range 越界：t1 = ${t1}s 超过片段「${clipName}」时长 ${duration}s。`,
      `把 t1 放回 0–${duration}s 且保持 t0 < t1；先用 kinemesh_info 查 clips[].duration。`,
    );
  }
  return [t0, Math.min(t1, duration)];
}

// ———————— 关节集解析（附录 A.0：humanoid 惯例集 > motion-top15 > explicit） ————————

interface Candidate {
  object: THREE.Object3D;
  depth: number;
}

function collectCandidates(root: THREE.Object3D): Candidate[] {
  const bones: Candidate[] = [];
  const named: Candidate[] = [];
  root.traverse((obj) => {
    if (obj === root) return;
    let depth = 0;
    for (let parent = obj.parent; parent !== null && parent !== root; parent = parent.parent) depth += 1;
    if ((obj as THREE.Bone).isBone) bones.push({ object: obj, depth });
    else if (obj.name !== '') named.push({ object: obj, depth });
  });
  return bones.length > 0 ? bones : named;
}

interface JointResolution {
  basis: JointBasis;
  jointObjects: THREE.Object3D[];
  joints: SampledJoint[];
  declaredJoints: string[];
  anchors: SampleAnchors;
  rootJoint: THREE.Object3D | null;
}

const EMPTY_ANCHORS: SampleAnchors = {
  hips: -1,
  head: -1,
  leftUpperLeg: -1,
  rightUpperLeg: -1,
  endEffectors: [],
  footPoints: [],
};

function slotKey(classification: { kind: JointKind; side: 'L' | 'R' | null }): string {
  return `${classification.side ?? ''}:${classification.kind}`;
}

function weightForId(id: string): number {
  const suffix = id.includes('.') ? (id.split('.')[1] ?? '') : id;
  const weight = (JOINT_WEIGHTS as Record<string, number | undefined>)[suffix];
  return weight ?? 0;
}

function buildAnchors(joints: SampledJoint[]): SampleAnchors {
  const indexById = new Map<string, number>();
  joints.forEach((joint, index) => {
    if (!indexById.has(joint.id)) indexById.set(joint.id, index);
  });
  const anchors: SampleAnchors = { ...EMPTY_ANCHORS, endEffectors: [], footPoints: [] };
  anchors.hips = indexById.get('hips') ?? -1;
  anchors.head = indexById.get('head') ?? -1;
  anchors.leftUpperLeg = indexById.get('L.UpperLeg') ?? -1;
  anchors.rightUpperLeg = indexById.get('R.UpperLeg') ?? -1;
  for (const id of ['L.Hand', 'R.Hand', 'L.Foot', 'R.Foot', 'head']) {
    const index = indexById.get(id);
    if (index !== undefined) anchors.endEffectors.push(index);
  }
  for (const side of ['L', 'R'] as const) {
    for (const id of [`${side}.Foot`, `${side}.Toe`]) {
      const index = indexById.get(id);
      if (index !== undefined) anchors.footPoints.push({ side, index });
    }
  }
  return anchors;
}

function resolveHumanoidJoints(root: THREE.Object3D): JointResolution | null {
  const names: string[] = [];
  root.traverse((obj) => {
    if (obj !== root && obj.name !== '') names.push(obj.name);
  });
  if (!isHumanoidLike(names)) return null;

  // 按 A.0 槽位表做首名占位：遍历顺序即优先级（先遇到的占槽）
  const slots = new Map<string, THREE.Object3D>();
  root.traverse((obj) => {
    if (obj === root || obj.name === '') return;
    const classification = classifyJointName(obj.name);
    if (!classification) return;
    const key = slotKey(classification);
    if (!slots.has(key)) slots.set(key, obj);
  });
  const hips = slots.get(':hips');
  if (!hips) return null; // 没有 hips 就没有 rootPos/heading 的锚，退 top15（A.5 口径）

  const jointObjects: THREE.Object3D[] = [];
  const joints: SampledJoint[] = [];
  const declaredJoints: string[] = [];
  const pushSlot = (plan: { id: string; kind: JointKind; side: 'L' | 'R' | null }): void => {
    const object = slots.get(slotKey({ kind: plan.kind, side: plan.side }));
    if (!object) {
      declaredJoints.push(plan.id);
      return;
    }
    jointObjects.push(object);
    joints.push({ id: plan.id, objectName: object.name, weight: weightForId(plan.id) });
  };
  for (const plan of J15_PLAN) pushSlot(plan);
  for (const toe of TOE_PLAN) {
    const object = slots.get(`${toe.side}:toe`);
    if (object) {
      jointObjects.push(object);
      joints.push({ id: toe.id, objectName: object.name, weight: 0 });
    }
  }
  return {
    basis: 'humanoid-conventions',
    jointObjects,
    joints,
    declaredJoints,
    anchors: buildAnchors(joints),
    rootJoint: hips,
  };
}

function resolveTop15Joints(root: THREE.Object3D, times: number[], evaluateAt: (t: number) => void): JointResolution {
  const candidates = collectCandidates(root);
  if (candidates.length === 0) {
    throw new KinemeshError(
      '场景中没有可采样的骨骼/命名节点。',
      '动作分析需要骨骼动画；先用 kinemesh_info 查看 bones 列表，或改用 kinemesh_render 逐帧查看。',
    );
  }
  // 世界位移方差 Top-15（附录 A.0 非人形回退）：流式累加 sum / sum-of-squares，不存全帧
  const scratch = new THREE.Vector3();
  const sums = candidates.map(() => ({ sx: 0, sy: 0, sz: 0, sxx: 0, syy: 0, szz: 0 }));
  for (const time of times) {
    evaluateAt(time);
    for (let c = 0; c < candidates.length; c += 1) {
      candidates[c]!.object.getWorldPosition(scratch);
      const sum = sums[c]!;
      sum.sx += scratch.x;
      sum.sy += scratch.y;
      sum.sz += scratch.z;
      sum.sxx += scratch.x * scratch.x;
      sum.syy += scratch.y * scratch.y;
      sum.szz += scratch.z * scratch.z;
    }
  }
  const n = times.length;
  const variance = sums.map((sum) => {
    const mx = sum.sx / n;
    const my = sum.sy / n;
    const mz = sum.sz / n;
    return Math.max(0, sum.sxx / n - mx * mx) + Math.max(0, sum.syy / n - my * my) + Math.max(0, sum.szz / n - mz * mz);
  });
  // 稳定排序：方差并列时保持遍历序（确定性）
  const ranked = candidates
    .map((candidate, index) => ({ candidate, variance: variance[index] ?? 0 }))
    .sort((a, b) => b.variance - a.variance)
    .slice(0, 15);
  const jointObjects = ranked.map((entry) => entry.candidate.object);
  const joints = jointObjects.map((object) => ({
    id: object.name,
    objectName: object.name,
    weight: 1,
  }));
  // rootJoint = 最靠上的候选（depth 最小；并列取遍历序）——heading 回退与 rootPos 参照
  const rootCandidate = candidates.reduce((best, candidate) => (candidate.depth < best.depth ? candidate : best));
  return {
    basis: 'motion-top15',
    jointObjects,
    joints,
    declaredJoints: [],
    anchors: { ...EMPTY_ANCHORS, endEffectors: [], footPoints: [] },
    rootJoint: rootCandidate.object,
  };
}

function resolveExplicitJoints(root: THREE.Object3D, requested: string[]): JointResolution {
  const byCanonicalId = new Map<string, string>();
  for (const plan of J15_PLAN) byCanonicalId.set(plan.id.toLowerCase(), plan.id);
  for (const toe of TOE_PLAN) byCanonicalId.set(toe.id.toLowerCase(), toe.id);

  const byName = new Map<string, THREE.Object3D>();
  root.traverse((obj) => {
    if (obj !== root && obj.name !== '' && !byName.has(obj.name.toLowerCase())) {
      byName.set(obj.name.toLowerCase(), obj);
    }
  });

  const jointObjects: THREE.Object3D[] = [];
  const joints: SampledJoint[] = [];
  const seen = new Set<THREE.Object3D>();
  const missing: string[] = [];
  for (const entry of requested) {
    const key = entry.trim().toLowerCase();
    const canonical = byCanonicalId.get(key);
    const object = canonical ? findByCanonicalId(root, canonical) : byName.get(key);
    if (!object) {
      missing.push(entry);
      continue;
    }
    if (seen.has(object)) continue;
    seen.add(object);
    jointObjects.push(object);
    joints.push({ id: canonical ?? object.name, objectName: object.name, weight: canonical ? weightForId(canonical) : 1 });
  }
  if (missing.length > 0) {
    throw new KinemeshError(
      `找不到指定关节：${missing.join('、')}。`,
      '关节可用 J15 规范名（如 L.Hand、R.Foot、hips）或场景骨骼名；先用 kinemesh_info 查看 bones 列表再指定。',
    );
  }
  if (joints.length === 0) {
    throw new KinemeshError(
      '场景中没有可采样的骨骼/命名节点。',
      '动作分析需要骨骼动画；先用 kinemesh_info 查看 bones 列表，或改用 kinemesh_render 逐帧查看。',
    );
  }
  const classificationById = new Map<string, { kind: JointKind; side: 'L' | 'R' | null }>();
  root.traverse((obj) => {
    if (obj !== root && obj.name !== '') {
      const classification = classifyJointName(obj.name);
      if (classification) classificationById.set(obj.name, classification);
    }
  });
  const hipsObject = jointObjects.find((obj) => classificationById.get(obj.name)?.kind === 'hips') ?? null;
  return {
    basis: 'explicit',
    jointObjects,
    joints,
    declaredJoints: [],
    anchors: buildAnchors(joints),
    rootJoint: hipsObject,
  };
}

function findByCanonicalId(root: THREE.Object3D, canonicalId: string): THREE.Object3D | undefined {
  // 规范名 → 场景对象：按惯例分类重走一遍槽位表（与 resolveHumanoidJoints 同序）
  const plan = J15_PLAN.find((slot) => slot.id === canonicalId) ?? TOE_PLAN.find((toe) => toe.id === canonicalId);
  if (!plan) return undefined;
  const kind = 'kind' in plan ? plan.kind : 'toe';
  const side = 'side' in plan ? plan.side : null;
  const key = slotKey({ kind: kind as JointKind, side: side as 'L' | 'R' | null });
  let found: THREE.Object3D | undefined;
  root.traverse((obj) => {
    if (found || obj === root || obj.name === '') return;
    const classification = classifyJointName(obj.name);
    if (classification && slotKey(classification) === key && (side === null || classification.side === side)) {
      found = obj;
    }
  });
  return found;
}

// ———————— 采样主流程 ————————

export function sampleClip(scene: CanonicalScene, options: SampleOptions = {}): SampleResult {
  const clip = pickClip(scene, options.clipName);
  const sampleFps = resolveSampleFps(options.sampleFps);
  const duration = clip.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new KinemeshError(
      `片段过短：动画片段「${clip.name}」时长为 ${duration}s，无法采样。`,
      '该 clip 没有有效时长；先用 kinemesh_info 确认 clips[].duration，换一个有时长的 clip。',
    );
  }
  // range 切片（M6f）：全片采样网格上取 t∈[t0,t1] 的码点，帧号/时间不重置（可直接喂 render）
  const range = resolveRange(options.range, clip.name, duration);
  const rangeEnd = range ? range[1] : duration;
  const kStart = range ? Math.ceil(range[0] * sampleFps - RANGE_GRID_EPS) : 0;
  const frameCount = range
    ? Math.floor(rangeEnd * sampleFps + RANGE_GRID_EPS) - kStart + 1
    : Math.ceil(duration * sampleFps);
  if (frameCount < 3) {
    throw new KinemeshError(
      range
        ? `片段过短：range [${range[0]}, ${range[1]}]s × sampleFps ${sampleFps} = ${frameCount} 采样帧（至少 3 帧）。`
        : `片段过短：时长 ${duration}s × sampleFps ${sampleFps} = ${frameCount} 采样帧（至少 3 帧）。`,
      `提高 sampleFps（1–${SAMPLE_FPS_MAX}）${range ? '或加大 range 跨度' : ''}；太短的片段不适合动作分析，换更长的 clip。`,
    );
  }
  if (frameCount > SAMPLE_COUNT_MAX) {
    throw new KinemeshError(
      range
        ? `采样点过多：range [${range[0]}, ${range[1]}]s × sampleFps ${sampleFps} = ${frameCount} 超过上限 ${SAMPLE_COUNT_MAX}。`
        : `采样点过多：时长 ${duration}s × sampleFps ${sampleFps} = ${frameCount} 超过上限 ${SAMPLE_COUNT_MAX}。`,
      `降低 sampleFps（当前 ${sampleFps}），或用 range 参数切片后分段分析。`,
    );
  }

  const root = scene.object;
  const snapshot = snapshotRestPose(root);
  try {
    const prepared = prepareTracks(root, clip);
    const dt = 1 / sampleFps;
    // 切片时 times 仍落在全片网格（k = kStart..kEnd−1），frame = round(t×30) 全片口径不重置
    const times = Array.from({ length: frameCount }, (_, k) => (kStart + k) * dt);
    const frames = times.map((time) => Math.round(time * RENDER_FPS));
    const evaluateAt = (time: number): void => {
      for (const track of prepared.bindings) {
        const values = track.interpolant.evaluate(time);
        track.binding.setValue(values, 0);
      }
      root.updateMatrixWorld(true);
    };

    // 关节集解析（A.0）：auto = humanoid 惯例集，匹配不上（或没有 hips）退 motion-top15
    const requested = options.joints ?? 'auto';
    const resolution =
      requested === 'auto'
        ? (resolveHumanoidJoints(root) ??
          resolveTop15Joints(root, times, evaluateAt))
        : resolveExplicitJoints(root, requested);
    const { joints, jointObjects } = resolution;

    const warnings: string[] = [];
    if (prepared.morphIgnored > 0) {
      warnings.push(`已忽略 ${prepared.morphIgnored} 条 morph/blend shape 轨道（骨骼运动分析不涉及形态动画）。`);
    }
    if (prepared.unresolved.length > 0) {
      const names = prepared.unresolved.slice(0, 5).join('、');
      const more = prepared.unresolved.length > 5 ? ` 等 ${prepared.unresolved.length} 条` : '';
      warnings.push(`有 ${prepared.unresolved.length} 条轨道未找到目标节点，已跳过：${names}${more}。`);
    }
    if (resolution.basis === 'motion-top15') {
      warnings.push('非人形骨架：关节集取世界位移方差 Top-15 骨骼（jointBasis=motion-top15），能量权重统一为 1。');
    }

    const jointCount = joints.length;
    const positions = new Float64Array(frameCount * jointCount * 3);
    const scratch = new THREE.Vector3();
    const scratchQ = new THREE.Quaternion();
    const rootJoint = resolution.rootJoint;
    const rootPositions = rootJoint ? new Float64Array(frameCount * 3) : null;
    const rootQuaternions = rootJoint ? new Float64Array(frameCount * 4) : null;

    for (let k = 0; k < frameCount; k += 1) {
      evaluateAt(times[k]!);
      for (let j = 0; j < jointCount; j += 1) {
        jointObjects[j]!.getWorldPosition(scratch);
        const base = (k * jointCount + j) * 3;
        positions[base] = scratch.x;
        positions[base + 1] = scratch.y;
        positions[base + 2] = scratch.z;
      }
      if (rootJoint && rootPositions && rootQuaternions) {
        rootJoint.getWorldPosition(scratch);
        rootPositions[k * 3] = scratch.x;
        rootPositions[k * 3 + 1] = scratch.y;
        rootPositions[k * 3 + 2] = scratch.z;
        rootJoint.getWorldQuaternion(scratchQ);
        rootQuaternions[k * 4] = scratchQ.x;
        rootQuaternions[k * 4 + 1] = scratchQ.y;
        rootQuaternions[k * 4 + 2] = scratchQ.z;
        rootQuaternions[k * 4 + 3] = scratchQ.w;
      }
    }

    // 精确端点（虚拟点 k=N）：切片时端点 = t1；seam 分量与「端点」关键帧专用，不进常规网格
    evaluateAt(rangeEnd);
    const endpointPositions = new Float64Array(jointCount * 3);
    for (let j = 0; j < jointCount; j += 1) {
      jointObjects[j]!.getWorldPosition(scratch);
      endpointPositions[j * 3] = scratch.x;
      endpointPositions[j * 3 + 1] = scratch.y;
      endpointPositions[j * 3 + 2] = scratch.z;
    }
    let endpointPosition: Float64Array | null = null;
    let endpointQuaternion: Float64Array | null = null;
    if (rootJoint) {
      rootJoint.getWorldPosition(scratch);
      endpointPosition = Float64Array.of(scratch.x, scratch.y, scratch.z);
      rootJoint.getWorldQuaternion(scratchQ);
      endpointQuaternion = Float64Array.of(scratchQ.x, scratchQ.y, scratchQ.z, scratchQ.w);
    }

    return {
      clipName: clip.name,
      duration,
      sampleFps,
      dt,
      frameCount,
      times,
      frames,
      endpointTime: rangeEnd,
      positions,
      endpointPositions,
      jointBasis: resolution.basis,
      joints,
      jointObjects,
      anchors: resolution.anchors,
      rootJoint,
      rootTrack:
        rootJoint && rootPositions && rootQuaternions && endpointPosition && endpointQuaternion
          ? { positions: rootPositions, quaternions: rootQuaternions, endpointPosition, endpointQuaternion }
          : null,
      declaredJoints: resolution.declaredJoints,
      warnings,
      ...(range ? { range } : {}),
    };
  } finally {
    restoreRestPose(root, snapshot);
  }
}
