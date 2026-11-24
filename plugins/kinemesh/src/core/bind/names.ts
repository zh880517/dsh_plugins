// 骨骼/节点名匹配（0.10.0「独立 mesh 文件」绑定）：动画轨道名 ↔ mesh 场景节点名的容错匹配。
//
// 为什么需要：动作文件与角色 mesh 常来自同一套 rig 的分两次导出（动作不带 mesh），两边的
// 骨骼名可能带导出器命名空间（Mixamo 的 `mixamorig:`、Unity/Blender 的 `Armature|`）、空格与大小写差异。
// 精确名优先，命中不了再按「去命名空间 + 去空格 + 小写」归一化名兜底；两种方式都命中不了才丢弃该轨道。
//
// 纯 three 对象操作（Node / 浏览器都能跑），Node 端可用真实 Object3D 直测。
import * as THREE from 'three';

/** 常见的导出器命名空间前缀（可叠加，如 `Armature|mixamorig:Hips`） */
const NAMESPACE_PREFIXES: readonly RegExp[] = [
  /^mixamorig\d*:/i,
  /^armature\s*[|:]\s*/i,
  /^root\s*[|:]\s*/i,
  /^biped\s*[|:]\s*/i,
  /^bip\d*\s*[|:]\s*/i,
];

/** 去掉命名空间前缀（最多剥 4 层，防止异常名字死循环） */
export function stripNodeNamespaces(name: string): string {
  let current = name.trim();
  for (let depth = 0; depth < 4; depth += 1) {
    let next = current;
    for (const pattern of NAMESPACE_PREFIXES) next = next.replace(pattern, '');
    if (next === current) break;
    current = next;
  }
  return current;
}

/** 归一化比较键：去命名空间 → 空格转下划线 → 小写 */
export function nodeNameKey(name: string): string {
  return stripNodeNamespaces(name).replace(/\s+/g, '_').toLowerCase();
}

export interface NodeIndex {
  /** 精确名 → 节点（重名取首个，与 three PropertyBinding.findNode 的口径一致） */
  exact: Map<string, THREE.Object3D>;
  /** 归一化名 → 节点（重名取首个） */
  normalized: Map<string, THREE.Object3D>;
  /** 命名节点总数（骨骼 + 网格 + 组） */
  count: number;
  /** 骨骼数 */
  bones: number;
}

/** 给 mesh 场景建节点索引（一次遍历，后续按名字查） */
export function buildNodeIndex(root: THREE.Object3D): NodeIndex {
  const exact = new Map<string, THREE.Object3D>();
  const normalized = new Map<string, THREE.Object3D>();
  let count = 0;
  let bones = 0;
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) bones += 1;
    const name = child.name;
    if (name === '') return;
    count += 1;
    if (!exact.has(name)) exact.set(name, child);
    const key = nodeNameKey(name);
    // 同时收原名的归一化键与「已被 GLTFLoader/PropertyBinding 清洗过」的键（空格→下划线）
    if (!normalized.has(key)) normalized.set(key, child);
    const sanitized = key.replace(/[.[\]:/]/g, '');
    if (!normalized.has(sanitized)) normalized.set(sanitized, child);
  });
  return { exact, normalized, count, bones };
}

export type NodeMatchVia = 'exact' | 'normalized';

export interface NodeMatch {
  node: THREE.Object3D;
  via: NodeMatchVia;
}

/** 查节点：精确名 > 归一化名；找不到返回 null */
export function matchNode(index: NodeIndex, nodeName: string): NodeMatch | null {
  const exact = index.exact.get(nodeName);
  if (exact !== undefined) return { node: exact, via: 'exact' };
  const key = nodeNameKey(nodeName);
  const normalized = index.normalized.get(key);
  if (normalized !== undefined) return { node: normalized, via: 'normalized' };
  const sanitized = key.replace(/[.[\]:/]/g, '');
  const fallback = index.normalized.get(sanitized);
  if (fallback !== undefined) return { node: fallback, via: 'normalized' };
  return null;
}
