// 动画片段重绑定（0.10.0「独立 mesh 文件」）：把动作文件里的 AnimationClip 轨道改成
// mesh 场景的骨骼名，让同一个 AnimationMixer 直接驱动 mesh 骨架。
//
// 适用场景：动作-only 的 FBX 与角色 mesh FBX 来自同一套 rig 的分两次导出——
// 动画轨道名与 mesh 骨骼名一致（或只差命名空间前缀）时，按名字换轨道前缀即可；
// 只导出部分骨骼的动作（如 5 根脊柱的受击附加动画）也能绑定，未命中的 mesh 骨骼保持 rest 姿态。
//
// 0.10.1（真实资产 Haylee 暴露）：同一套 rig 分两次导出时，根骨骼（Bip001 / Hips 等顶层被动画节点）
// 的**静止朝向**可能不同（典型：mesh 导 Z-up、动作导 Y-up，FBXLoader 只给 mesh 根节点加 −90°X 旋转，
// 两个文件的骨骼局部数据因此整体差一个根旋转）。直接搬局部值会让角色「躺倒」。
// 修法：只看映射链的根骨骼，按两边静止姿态差做一次校正——
//   q_t(t) = q_t_rest · q_s_rest⁻¹ · q_s(t)
//   p_t(t) = p_t_rest + R(q_t_rest·q_s_rest⁻¹)·(p_s(t) − p_s_rest)
// 子骨骼局部值保持原样即可（父链朝向被校正后，整条链在世界空间对齐）。
//
// 纯 three 对象操作（Node / 浏览器都能跑），Node 端可用真实 Object3D/AnimationClip 直测。
import * as THREE from 'three';
import { buildNodeIndex, matchNode, type NodeIndex } from './names.js';

/** 绑定报告（info / render warnings 引用；数值全部由本模块产出，AI 只引用） */
export interface ClipBindingReport {
  /** mesh 场景命名节点数（骨骼 + 网格 + 组） */
  meshNodes: number;
  /** mesh 场景骨骼数 */
  meshBones: number;
  /** 动画里被轨道驱动的节点数（去重） */
  animNodes: number;
  /** 命中 mesh 节点的动画节点数 */
  matchedNodes: number;
  /** 命中的动画节点里属于骨骼的数量（动画也可能驱动武器网格等非骨骼节点） */
  matchedBones: number;
  /** 全部轨道数 */
  totalTracks: number;
  /** 命中 mesh 节点的轨道数 */
  matchedTracks: number;
  /** 没命中 mesh 节点的动画节点名（去重，最多 12 个；完整数见 unmatchedNodeCount） */
  unmatchedNodes: string[];
  /** 没命中的动画节点总数（去重） */
  unmatchedNodeCount: number;
  /** 通过命名空间归一化（mixamorig: / Armature| 等）才命中的轨道数 */
  renamedTracks: number;
  /** 做了「静止姿态差」校正的根骨骼名（两边根朝向不同时非空） */
  correctedRoots: string[];
  /** 是否至少命中一条轨道（false = 动画与 mesh 骨骼完全不匹配，调用方应报错） */
  ok: boolean;
  warnings: string[];
}

export interface ClipBindingResult {
  /** 重绑定后的片段（轨道名已换成 mesh 节点名；未命中的轨道被丢弃） */
  clips: THREE.AnimationClip[];
  report: ClipBindingReport;
}

/** 动画轨道里命中的节点名去重上限（报告里只列前 12 个，避免长清单灌爆 token） */
const MAX_UNMATCHED_NODES = 12;

/** 根骨骼静止姿态差校正数据（两边局部 rest 值） */
interface RootCorrection {
  /** targetRest · sourceRest⁻¹ 的旋转：delta 从源根局部空间转到目标根局部空间 */
  rotation: THREE.Quaternion;
  targetPosition: THREE.Vector3;
  targetScale: THREE.Vector3;
  sourcePosition: THREE.Vector3;
  sourceScale: THREE.Vector3;
  targetName: string;
}

/**
 * 把动画片段绑定到 mesh 场景：逐轨道查 mesh 节点（精确名 > 命名空间归一化名），
 * 命中则换轨道名前缀，未命中则丢弃；给了 sourceRoot（动画文件自己的场景根）时，
 * 对映射链的根骨骼按两边静止姿态差做校正（修跨导出 up-axis / 根朝向差异导致的「躺倒」）。
 * 不修改入参 clips / mesh / sourceRoot（轨道都是 clone 的），可以安全地在只读分析里调用。
 */
export function bindClipsToModel(
  mesh: THREE.Object3D,
  clips: readonly THREE.AnimationClip[],
  sourceRoot?: THREE.Object3D,
): ClipBindingResult {
  const index = buildNodeIndex(mesh);
  // 第一遍：轨道节点名 → mesh 节点（跨 clip 复用；同时统计未命中）
  const resolved = new Map<string, { target: THREE.Object3D; via: 'exact' | 'normalized' }>();
  const unseen = new Set<string>();
  let totalTracks = 0;
  let matchedTracks = 0;
  const parsedNames = new Map<THREE.KeyframeTrack, { nodeName: string; property: string }>();

  for (const clip of clips) {
    for (const track of clip.tracks) {
      totalTracks += 1;
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const nodeName = typeof parsed.nodeName === 'string' ? parsed.nodeName : '';
      parsedNames.set(track, { nodeName, property: typeof parsed.propertyName === 'string' ? parsed.propertyName : '' });
      if (nodeName === '') continue;
      if (resolved.has(nodeName)) {
        matchedTracks += 1;
        continue;
      }
      const hit = matchNode(index, nodeName);
      if (hit === null) {
        unseen.add(nodeName);
        continue;
      }
      resolved.set(nodeName, { target: hit.node, via: hit.via });
      matchedTracks += 1;
    }
  }

  // 映射链的根骨骼（没有 mapped 祖先的 mesh 骨骼）→ 用两边静止姿态差校正
  const matchedTargets = new Set([...resolved.values()].map((entry) => entry.target));
  const corrections = buildRootCorrections(matchedTargets, sourceRoot);

  // 第二遍：生成绑定后的轨道
  const matchedBones = new Set<THREE.Object3D>();
  const matchedNodes = new Set<string>();
  let renamedTracks = 0;
  const boundClips: THREE.AnimationClip[] = [];
  for (const clip of clips) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const info = parsedNames.get(track);
      const nodeName = info?.nodeName ?? '';
      if (nodeName === '') {
        // 非节点轨道（理论上动画轨道都有节点名）：原样保留，不参与命中统计
        tracks.push(track);
        continue;
      }
      const entry = resolved.get(nodeName);
      if (entry === undefined) continue; // 未命中：丢弃
      if (!matchedNodes.has(nodeName)) {
        matchedNodes.add(nodeName);
        if ((entry.target as THREE.Bone).isBone) matchedBones.add(entry.target);
      }
      // three 的 parseTrackName 已能忽略 mixamorig: 这类前缀：解析出的 nodeName 与目标同名时沿用原轨道名
      const nameMatches = entry.target.name === nodeName;
      const suffix = track.name.startsWith(nodeName) ? track.name.slice(nodeName.length) : `.${info?.property ?? ''}`;
      const targetName = nameMatches ? track.name : `${entry.target.name}${suffix}`;
      const correction = corrections.get(entry.target);
      if (correction !== undefined) {
        const corrected = correctTrack(track, info?.property ?? '', correction);
        if (corrected !== null) {
          corrected.name = targetName;
          tracks.push(corrected);
          if (!nameMatches) renamedTracks += 1;
          continue;
        }
      }
      if (nameMatches) {
        tracks.push(track);
        continue;
      }
      const renamed = track.clone();
      renamed.name = targetName;
      renamedTracks += 1;
      tracks.push(renamed);
    }
    boundClips.push(new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode));
  }

  const report: ClipBindingReport = {
    meshNodes: index.count,
    meshBones: index.bones,
    animNodes: matchedNodes.size + unseen.size,
    matchedNodes: matchedNodes.size,
    matchedBones: matchedBones.size,
    totalTracks,
    matchedTracks,
    unmatchedNodes: [...unseen].slice(0, MAX_UNMATCHED_NODES),
    unmatchedNodeCount: unseen.size,
    renamedTracks,
    correctedRoots: [...corrections.keys()].map((target) => target.name),
    ok: matchedTracks > 0,
    warnings: [],
  };
  report.warnings.push(...bindingWarnings(report));
  return { clips: boundClips, report };
}

/** 找出映射链根骨骼并计算校正量（只对「两边都有、且静止朝向/位置不同」的根骨骼） */
function buildRootCorrections(matchedTargets: Set<THREE.Object3D>, sourceRoot?: THREE.Object3D): Map<THREE.Object3D, RootCorrection> {
  const corrections = new Map<THREE.Object3D, RootCorrection>();
  if (sourceRoot === undefined) return corrections;
  const sourceBones = new Map<string, THREE.Bone>();
  sourceRoot.traverse((child) => {
    if ((child as THREE.Bone).isBone) sourceBones.set(child.name, child as THREE.Bone);
  });
  if (sourceBones.size === 0) return corrections;
  for (const target of matchedTargets) {
    if ((target as THREE.Bone).isBone !== true) continue;
    if (hasMatchedAncestor(target, matchedTargets)) continue;
    const source = sourceBones.get(target.name);
    if (source === undefined) continue;
    const targetRest = { p: target.position, q: target.quaternion, s: target.scale };
    const sourceRest = { p: source.position, q: source.quaternion, s: source.scale };
    const rotation = targetRest.q.clone().multiply(sourceRest.q.clone().invert());
    const positionDelta = targetRest.p.distanceTo(sourceRest.p);
    const rotationDelta = rotation.angleTo(new THREE.Quaternion());
    const scaleDelta = targetRest.s.distanceTo(sourceRest.s);
    if (positionDelta < 1e-4 && rotationDelta < 1e-3 && scaleDelta < 1e-4) continue; // 静止姿态一致：无需校正
    corrections.set(target, {
      rotation,
      targetPosition: targetRest.p.clone(),
      targetScale: targetRest.s.clone(),
      sourcePosition: sourceRest.p.clone(),
      sourceScale: sourceRest.s.clone(),
      targetName: target.name,
    });
  }
  return corrections;
}

function hasMatchedAncestor(target: THREE.Object3D, matchedTargets: Set<THREE.Object3D>): boolean {
  let parent = target.parent;
  while (parent !== null && parent !== undefined) {
    if (matchedTargets.has(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

/** 单条轨道按根校正量做静止姿态差变换（position/quaternion/scale；其它属性原样返回 null） */
function correctTrack(track: THREE.KeyframeTrack, property: string, correction: RootCorrection): THREE.KeyframeTrack | null {
  const values = track.values;
  if (property === 'quaternion') {
    const out = new Float32Array(values.length);
    const q = new THREE.Quaternion();
    for (let index = 0; index + 3 < values.length; index += 4) {
      q.set(values[index]!, values[index + 1]!, values[index + 2]!, values[index + 3]!);
      q.premultiply(correction.rotation);
      out[index] = q.x;
      out[index + 1] = q.y;
      out[index + 2] = q.z;
      out[index + 3] = q.w;
    }
    return new THREE.QuaternionKeyframeTrack(track.name, track.times, out);
  }
  if (property === 'position') {
    const out = new Float32Array(values.length);
    const point = new THREE.Vector3();
    for (let index = 0; index + 2 < values.length; index += 3) {
      point.set(
        values[index]! - correction.sourcePosition.x,
        values[index + 1]! - correction.sourcePosition.y,
        values[index + 2]! - correction.sourcePosition.z,
      );
      point.applyQuaternion(correction.rotation);
      out[index] = correction.targetPosition.x + point.x;
      out[index + 1] = correction.targetPosition.y + point.y;
      out[index + 2] = correction.targetPosition.z + point.z;
    }
    return new THREE.VectorKeyframeTrack(track.name, track.times, out);
  }
  if (property === 'scale') {
    const out = new Float32Array(values.length);
    for (let index = 0; index + 2 < values.length; index += 3) {
      out[index] = correction.targetScale.x * (values[index]! / (correction.sourceScale.x || 1));
      out[index + 1] = correction.targetScale.y * (values[index + 1]! / (correction.sourceScale.y || 1));
      out[index + 2] = correction.targetScale.z * (values[index + 2]! / (correction.sourceScale.z || 1));
    }
    return new THREE.VectorKeyframeTrack(track.name, track.times, out);
  }
  return null;
}

/** 由报告派生人话 warnings（截图/预览/工具直接透传） */
function bindingWarnings(report: ClipBindingReport): string[] {
  const warnings: string[] = [];
  if (!report.ok) {
    warnings.push(
      `动画与 mesh 骨骼完全不匹配：动画 ${report.animNodes} 个节点没有一个命中 mesh 骨架（${report.meshBones} 根骨骼）。`,
    );
    return warnings;
  }
  if (report.unmatchedNodeCount > 0) {
    const sample = report.unmatchedNodes.join('、');
    warnings.push(
      `动画有 ${report.unmatchedNodeCount} 个节点在 mesh 骨架里没有对应骨骼，已忽略` +
        `（常见于动作里带的道具/相机/IK 辅助节点）：${sample}${report.unmatchedNodeCount > MAX_UNMATCHED_NODES ? ' …' : ''}`,
    );
  }
  if (report.renamedTracks > 0) {
    warnings.push(`按命名空间归一化匹配了 ${report.renamedTracks} 条轨道（如 mixamorig: / Armature| 前缀）。`);
  }
  if (report.correctedRoots.length > 0) {
    warnings.push(
      `动画与 mesh 的根骨骼静止朝向/位置不同（跨导出/坐标系差异，典型是 Z-up 与 Y-up 混用）：` +
        `已按静止姿态差校正根骨骼 ${report.correctedRoots.join('、')} 的轨道。`,
    );
  }
  return warnings;
}

/** 报告 → 给 AI 读的中文事实句（info/CLI/MCP 共用，数值不重复计算） */
export function bindingFacts(report: ClipBindingReport): string[] {
  const facts: string[] = [];
  facts.push(
    `动画驱动 mesh 骨架的 ${report.matchedBones}/${report.meshBones} 根骨骼；轨道命中 ${report.matchedTracks}/${report.totalTracks}。`,
  );
  if (report.unmatchedNodeCount > 0) {
    facts.push(
      `未匹配动画节点 ${report.unmatchedNodeCount} 个（示例：${report.unmatchedNodes.join('、')}${report.unmatchedNodeCount > report.unmatchedNodes.length ? ' …' : ''}）——这些节点的动作不会显示。`,
    );
  }
  if (report.renamedTracks > 0) facts.push(`其中 ${report.renamedTracks} 条轨道经命名空间归一化后命中。`);
  if (report.correctedRoots.length > 0) {
    facts.push(`根骨骼静止姿态差校正：${report.correctedRoots.join('、')}（两边 up-axis/根朝向不同）。`);
  }
  return facts;
}

export type { NodeIndex };
