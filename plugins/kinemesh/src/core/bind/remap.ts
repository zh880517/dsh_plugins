// 动画片段重绑定（0.10.0「独立 mesh 文件」）：把动作文件里的 AnimationClip 轨道改成
// mesh 场景的骨骼名，让同一个 AnimationMixer 直接驱动 mesh 骨架。
//
// 适用场景：动作-only 的 FBX 与角色 mesh FBX 来自同一套 rig 的分两次导出。
// 0.10.0–0.10.3 只按名字换轨道前缀（加根骨骼静止姿态差校正）；真实资产 Haylee 暴露：
// 分两次导出的两个文件 bind pose / up-axis 可能不同（一个 Z-up 一个 Y-up），
// 直接搬局部值会让肢体朝向错位（「旋转不对」）。
//
// 0.10.4 改为**世界姿态对齐烘焙**（不是逐骨静止差，也不是只换名字）：
//   · 用动画文件自己的骨架把片段求值出来（AnimationMixer），逐个采样时刻算世界矩阵；
//   · 把世界姿态经场景朝向映射 C = mesh 场景根 · 动画场景根⁻¹ 对齐到 mesh 空间；
//   · 再按 mesh 骨架层级反解局部 TRS，写成新片段（只覆盖「该片段真正驱动的节点」）。
// 这样预览里看到的姿态 = 动画文件自己的姿态（整体刚体变换到 mesh 坐标系），
// 不会因为 bind pose 不同把肢体角度算歪；根位移/旋转仍留在根骨骼轨道上，
// root motion 锁定等预览功能不受影响。
//
// 纯 three 对象操作（Node / 浏览器都能跑）；轨道都是新建的，不修改入参场景。
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
  /** 按世界姿态对齐重定向（烘焙）的节点数；0 = 直接搬局部值（给了动画场景根时才烘焙） */
  retargetedBones: number;
  /** 静止姿态与 mesh 不同的映射链根骨骼名（bind pose / up-axis 差异的可读线索） */
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

/**
 * 把动画片段绑定到 mesh 场景：逐轨道查 mesh 节点（精确名 > 命名空间归一化名），
 * 命中则换轨道名前缀、未命中丢弃；给了 sourceRoot（动画文件自己的场景根）时，
 * 用「世界姿态对齐烘焙」把动作姿态精确转到 mesh 空间（修 bind pose / up-axis 差异）。
 * 不修改入参 clips / mesh / sourceRoot。
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

  for (const clip of clips) {
    for (const track of clip.tracks) {
      totalTracks += 1;
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const nodeName = typeof parsed.nodeName === 'string' ? parsed.nodeName : '';
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

  let renamedTracks = 0;
  for (const [nodeName, entry] of resolved) if (entry.target.name !== nodeName) renamedTracks += 1;

  const matchedBones = new Set<THREE.Object3D>();
  for (const entry of resolved.values()) {
    if ((entry.target as THREE.Bone).isBone && (entry.target as THREE.Bone).isBone !== undefined) matchedBones.add(entry.target);
  }
  const matchedTargets = new Set([...resolved.values()].map((entry) => entry.target));
  const matchedRoots = findMatchedRoots(matchedTargets);

  let boundClips: THREE.AnimationClip[] = [];
  let retargetedBones = 0;
  let correctedRoots: string[] = [];
  if (sourceRoot !== undefined) {
    const baked = bakeWorldAlignedClips(mesh, clips, resolved, sourceRoot);
    if (baked !== null) {
      boundClips = baked.clips;
      retargetedBones = baked.bones;
      correctedRoots = baked.correctedRoots;
    }
  }
  if (boundClips.length === 0) {
    // 没有动画场景根（单测 / 只给轨道）时退回「换轨道名 + 未命中丢弃」。
    // 世界姿态对齐需要动画自己的骨架做参考；缺少时只能按名字对齐。
    boundClips = remapTracksOnly(clips, resolved);
  }

  const report: ClipBindingReport = {
    meshNodes: index.count,
    meshBones: index.bones,
    animNodes: matchedTargets.size + unseen.size,
    matchedNodes: matchedTargets.size,
    matchedBones: matchedBones.size,
    totalTracks,
    matchedTracks,
    unmatchedNodes: [...unseen].slice(0, MAX_UNMATCHED_NODES),
    unmatchedNodeCount: unseen.size,
    renamedTracks,
    retargetedBones,
    correctedRoots,
    ok: matchedTracks > 0,
    warnings: [],
  };
  report.warnings.push(...bindingWarnings(report));
  return { clips: boundClips, report };
}

/** 映射链的根骨骼：命中目标里没有命中祖先的那些（Bip001 / Hips 等） */
function findMatchedRoots(matchedTargets: Set<THREE.Object3D>): Set<THREE.Object3D> {
  const roots = new Set<THREE.Object3D>();
  for (const target of matchedTargets) {
    let parent = target.parent;
    let hasMatchedAncestor = false;
    while (parent !== null && parent !== undefined) {
      if (matchedTargets.has(parent)) {
        hasMatchedAncestor = true;
        break;
      }
      parent = parent.parent;
    }
    if (!hasMatchedAncestor) roots.add(target);
  }
  return roots;
}

/** 无动画场景根时的降级路径：换轨道名前缀 / 丢弃未命中轨道（原 0.10.0 行为） */
function remapTracksOnly(
  clips: readonly THREE.AnimationClip[],
  resolved: Map<string, { target: THREE.Object3D; via: 'exact' | 'normalized' }>,
): THREE.AnimationClip[] {
  const out: THREE.AnimationClip[] = [];
  for (const clip of clips) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const nodeName = typeof parsed.nodeName === 'string' ? parsed.nodeName : '';
      if (nodeName === '') {
        tracks.push(track);
        continue;
      }
      const entry = resolved.get(nodeName);
      if (entry === undefined) continue;
      if (entry.target.name === nodeName) {
        tracks.push(track);
        continue;
      }
      const suffix = track.name.startsWith(nodeName) ? track.name.slice(nodeName.length) : `.${parsed.propertyName}`;
      const renamed = track.clone();
      renamed.name = `${entry.target.name}${suffix}`;
      tracks.push(renamed);
    }
    out.push(new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode));
  }
  return out;
}

interface BakedClips {
  clips: THREE.AnimationClip[];
  bones: number;
  correctedRoots: string[];
}

/**
 * 世界姿态对齐烘焙：动画骨架逐采样时刻求值 → 世界矩阵 → 按 mesh 层级反解局部 TRS。
 * 两个文件都被 FBXLoader 统一到 Y-up 世界，所以直接复制动画骨架的世界姿态即可；
 * mesh 场景根的旋转由反解出的局部值自动吸收（再乘场景根矩阵会二次旋转，Sword 资产实测会躺倒）。
 * 只烘焙「该片段轨道真正驱动的命中节点」；其余骨骼保持 mesh 自己的 rest 局部值。
 */
function bakeWorldAlignedClips(
  mesh: THREE.Object3D,
  clips: readonly THREE.AnimationClip[],
  resolved: Map<string, { target: THREE.Object3D; via: 'exact' | 'normalized' }>,
  sourceRoot: THREE.Object3D,
): BakedClips | null {
  const sourceNodes = new Map<string, THREE.Object3D>();
  sourceRoot.traverse((child) => {
    if (child.name !== '' && !sourceNodes.has(child.name)) sourceNodes.set(child.name, child);
  });
  const targetToSource = new Map<THREE.Object3D, THREE.Object3D>();
  for (const [nodeName, entry] of resolved) {
    const source = sourceNodes.get(entry.target.name) ?? sourceNodes.get(nodeName);
    if (source !== undefined) targetToSource.set(entry.target, source);
  }
  if (targetToSource.size === 0) return null;

  mesh.updateMatrixWorld(true);
  sourceRoot.updateMatrixWorld(true);

  // mesh 上的全部节点（按父→子顺序）与静止局部矩阵
  const nodes: THREE.Object3D[] = [];
  mesh.traverse((node) => {
    if (node !== mesh) nodes.push(node);
  });
  const restLocal = new Map<THREE.Object3D, THREE.Matrix4>();
  for (const node of nodes) restLocal.set(node, node.matrix.clone());
  const targetSet = new Set(targetToSource.keys());

  // 静止姿态差诊断（给报告/警告）：映射链根骨骼的局部 rest 是否与动画不同
  const correctedRoots: string[] = [];
  for (const root of findMatchedRoots(targetSet)) {
    const source = targetToSource.get(root);
    if (source === undefined) continue;
    const angular = root.quaternion.angleTo(source.quaternion);
    const linear = root.position.distanceTo(source.position);
    if (angular > 0.01 || linear > 1e-3) correctedRoots.push(root.name);
  }

  const bakedClips: THREE.AnimationClip[] = [];
  let bakedBones = 0;
  const localMatrix = new THREE.Matrix4();
  const desiredWorld = new Map<THREE.Object3D, THREE.Matrix4>();

  for (const clip of clips) {
    // 该片段真正驱动的命中节点
    const animated = new Set<THREE.Object3D>();
    const times = new Set<number>();
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const nodeName = typeof parsed.nodeName === 'string' ? parsed.nodeName : '';
      if (nodeName === '') continue;
      const entry = resolved.get(nodeName);
      if (entry !== undefined && targetToSource.has(entry.target)) animated.add(entry.target);
      for (const time of track.times) times.add(Math.round(time * 1000) / 1000);
    }
    const sampleTimes = [...times].sort((left, right) => left - right);
    if (sampleTimes.length === 0) {
      bakedClips.push(new THREE.AnimationClip(clip.name, clip.duration, [], clip.blendMode));
      continue;
    }
    // 采样缓冲（每个被驱动节点的 position/quaternion/scale 关键值）
    const buffers = new Map<THREE.Object3D, { p: number[]; q: number[]; s: number[] }>();
    for (const target of animated) buffers.set(target, { p: [], q: [], s: [] });

    const mixer = new THREE.AnimationMixer(sourceRoot);
    const action = mixer.clipAction(clip);
    action.reset().play();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    for (const time of sampleTimes) {
      mixer.setTime(time);
      sourceRoot.updateMatrixWorld(true);
      desiredWorld.clear();
      for (const node of nodes) {
        const parentWorld =
          node.parent !== null && node.parent !== mesh && desiredWorld.has(node.parent)
            ? desiredWorld.get(node.parent)!
            : mesh.matrixWorld;
        const source = targetToSource.get(node);
        let world: THREE.Matrix4;
        if (source !== undefined) {
          // 两个文件都已被 loader 统一到 Y-up 世界；直接复制动画骨架的世界姿态，
          // 由反解的局部值自动吸收 mesh 场景根的旋转（不能再用场景根矩阵做映射，会二次旋转）
          world = source.matrixWorld.clone();
        } else {
          // 未被动画驱动：按 mesh 自己的静止局部值跟随父链
          world = parentWorld.clone().multiply(restLocal.get(node)!);
        }
        desiredWorld.set(node, world);
        const buffer = animated.has(node) ? buffers.get(node) : undefined;
        if (buffer === undefined) continue;
        localMatrix.copy(parentWorld).invert().multiply(world);
        localMatrix.decompose(position, quaternion, scale);
        buffer.p.push(position.x, position.y, position.z);
        buffer.q.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        buffer.s.push(scale.x, scale.y, scale.z);
      }
    }
    action.stop();
    const tracks: THREE.KeyframeTrack[] = [];
    for (const [target, buffer] of buffers) {
      tracks.push(new THREE.VectorKeyframeTrack(`${target.name}.position`, sampleTimes, buffer.p));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${target.name}.quaternion`, sampleTimes, buffer.q));
      tracks.push(new THREE.VectorKeyframeTrack(`${target.name}.scale`, sampleTimes, buffer.s));
      if ((target as THREE.Bone).isBone) bakedBones += 1;
    }
    bakedClips.push(new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode));
  }
  return { clips: bakedClips, bones: bakedBones, correctedRoots };
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
    warnings.push(`按命名空间归一化匹配了 ${report.renamedTracks} 个节点（如 mixamorig: / Armature| 前缀）。`);
  }
  if (report.retargetedBones > 0) {
    const roots = report.correctedRoots.length > 0 ? `（根骨骼静止姿态不同：${report.correctedRoots.join('、')}）` : '';
    warnings.push(
      `动画与 mesh 的骨骼静止姿态/坐标系不同（bind pose 或 Z-up/Y-up 差异）：已按「世界姿态对齐」烘焙重定向 ` +
        `${report.retargetedBones} 根骨骼的轨道，预览姿态与动画文件自身一致${roots}。`,
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
  if (report.renamedTracks > 0) facts.push(`其中 ${report.renamedTracks} 个节点经命名空间归一化后命中。`);
  if (report.retargetedBones > 0) {
    facts.push(
      `世界姿态对齐烘焙重定向 ${report.retargetedBones} 根骨骼（bind pose / 跨导出差异）` +
        (report.correctedRoots.length > 0 ? `，根骨骼 rest 不同：${report.correctedRoots.join('、')}` : '') +
        '。',
    );
  }
  return facts;
}

export type { NodeIndex };
