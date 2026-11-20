// B.4 骨骼名标注的批次划分与骨架清单收集（design.md §7.3 / 附录 B.4）。
// Node 报告（skeleton-report.ts）与浏览器截图页（viewer-page.ts → viewer.js 产物）共用：
// 本模块不得引入 fs / DOM / bone-map（后者带 node:fs），否则浏览器 IIFE 构建会断。
import * as THREE from 'three';
import { LABELS_PER_SHOT } from '../motion/constants.js';

export interface LabelTarget {
  name: string;
  /** 层级 DFS（先序）序号——批次分配的 stride 基准 */
  dfsIndex: number;
}

/**
 * B.4 stride 分批（纯函数）：批数 B = ceil(目标数 / LABELS_PER_SHOT(12))；
 * 第 i 批 = DFS 序号 ≡ i (mod B)（1 起批号 = 下标 + 1，与 PNG 两位序号一致）。
 * 相邻 DFS 序号（父子骨）必然分属不同批，从根上避免批内标签互叠；
 * 目标总数 ≤ 12 时单批全量；目标为空返回空数组；空批保留为空数组（批号稳定）。
 */
export function strideLabelBatches(targets: LabelTarget[]): string[][] {
  if (targets.length === 0) return [];
  const batchCount = Math.max(1, Math.ceil(targets.length / LABELS_PER_SHOT));
  const batches: string[][] = Array.from({ length: batchCount }, () => []);
  for (const target of targets) {
    batches[target.dfsIndex % batchCount]!.push(target.name);
  }
  return batches;
}

/**
 * 与 collectSkeletonSet（skeleton-report.ts）同口径的 DFS 骨架清单收集：
 * 场景有 Bone 收 Bone，否则收命名节点；空名节点与 Mesh 一律跳过
 * （骨架清单是关节，不是渲染网格）。viewer 页侧给 setBoneLabels 解析批次用，
 * 与 skeleton-report 的 dfsIndex 序号保持一致是两条路径批号可对齐的前提。
 */
export function collectLabelTargets(root: THREE.Object3D): LabelTarget[] {
  let hasBones = false;
  root.traverse((obj) => {
    if (obj !== root && (obj as THREE.Bone).isBone) hasBones = true;
  });
  const targets: LabelTarget[] = [];
  const walk = (obj: THREE.Object3D): void => {
    for (const child of obj.children) {
      const isCandidate =
        child.name !== '' && !(child as THREE.Mesh).isMesh && (!hasBones || (child as THREE.Bone).isBone);
      if (isCandidate) targets.push({ name: child.name, dfsIndex: targets.length });
      walk(child);
    }
  };
  walk(root);
  return targets;
}
