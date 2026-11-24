// 动画片段重绑定（0.10.0「独立 mesh 文件」）：把动作文件里的 AnimationClip 轨道改成
// mesh 场景的骨骼名，让同一个 AnimationMixer 直接驱动 mesh 骨架（无需改动画数值、无需 retarget 矩阵）。
//
// 适用场景：动作-only 的 FBX 与角色 mesh FBX 来自同一套 rig 的分两次导出——
// 动画轨道名与 mesh 骨骼名一致（或只差命名空间前缀）时，按名字换轨道前缀即可；
// 只导出部分骨骼的动作（如 5 根脊柱的受击附加动画）也能绑定，未命中的mesh骨骼保持 rest 姿态。
//
// 纯 three 对象操作（Node / 浏览器都能跑），Node 端可用真实 AnimationClip 直测。
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
 * 命中则把轨道名前缀换成 mesh 节点名，未命中则丢弃。
 * 不修改入参 clips / mesh 对象（轨道是 clone 的），可以安全地在只读分析里调用。
 */
export function bindClipsToModel(mesh: THREE.Object3D, clips: readonly THREE.AnimationClip[]): ClipBindingResult {
  const index = buildNodeIndex(mesh);
  const matched = new Set<string>();
  const matchedBones = new Set<THREE.Object3D>();
  const unseen = new Set<string>();
  const boundClips: THREE.AnimationClip[] = [];
  let totalTracks = 0;
  let matchedTracks = 0;
  let renamedTracks = 0;

  for (const clip of clips) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      totalTracks += 1;
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const nodeName = typeof parsed.nodeName === 'string' ? parsed.nodeName : '';
      if (nodeName === '') {
        // 非节点轨道（理论上动画轨道都有节点名）：原样保留，不参与命中统计
        tracks.push(track);
        continue;
      }
      const hit = matchNode(index, nodeName);
      if (hit === null) {
        unseen.add(nodeName);
        continue;
      }
      matched.add(nodeName);
      if ((hit.node as THREE.Bone).isBone) matchedBones.add(hit.node);
      matchedTracks += 1;
      if (hit.node.name === nodeName) {
        tracks.push(track);
        continue;
      }
      // 命名空间/大小写差异命中：换前缀，保留 `.position` / `.quaternion` 等属性段
      const suffix = track.name.startsWith(nodeName) ? track.name.slice(nodeName.length) : '';
      const renamed = track.clone();
      renamed.name = suffix === '' ? `${hit.node.name}.${parsed.propertyName}` : `${hit.node.name}${suffix}`;
      renamedTracks += 1;
      tracks.push(renamed);
    }
    boundClips.push(new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode));
  }

  const animNodes = matched.size + unseen.size;
  const report: ClipBindingReport = {
    meshNodes: index.count,
    meshBones: index.bones,
    animNodes,
    matchedNodes: matched.size,
    matchedBones: matchedBones.size,
    totalTracks,
    matchedTracks,
    unmatchedNodes: [...unseen].slice(0, MAX_UNMATCHED_NODES),
    unmatchedNodeCount: unseen.size,
    renamedTracks,
    ok: matchedTracks > 0,
    warnings: [],
  };
  report.warnings.push(...bindingWarnings(report));
  return { clips: boundClips, report };
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
  return facts;
}

export type { NodeIndex };
