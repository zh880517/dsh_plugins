// root motion 开关（0.9.0，用户需求）：预览时可以选择去掉根位移 / 根旋转，让角色原地播放。
//
// 为什么需要：带 root motion 的动作（冲刺、突进、360 转身斩）在预览里会把角色带出画面或转走，
// 想按住看局部动作时很不方便；3D 工具通常提供 "in place / root motion off" 选项。
//
// 做法：找到「最上层的被动画节点」（FBX 的 Bip001、Mixamo 的 Hips、glTF 的根节点等，
// 即 root motion 载体），记录它在载入静止姿态下的 position/quaternion；每帧动画求值后
// 按开关把这两项写回参考值——位移锁 = 只还原位置，旋转锁 = 只还原朝向，两个都锁 = 完全原地。
// 注意不要动子节点：肢体动画必须保留，否则就成了 T-pose。
//
// 纯对象操作（只依赖 three），Node 端可用真实 Object3D/AnimationClip 直测。
import * as THREE from 'three';

export interface RootMotionLock {
  /** 锁定根位移（水平/垂直位移都还原为静止值） */
  translation: boolean;
  /** 锁定根旋转（朝向还原为静止值，转身类动作会留在初始朝向） */
  rotation: boolean;
}

export const ROOT_MOTION_UNLOCKED: RootMotionLock = { translation: false, rotation: false };

export interface RootPoseEntry {
  node: THREE.Object3D;
  /** 参考位置（载入静止姿态） */
  position: THREE.Vector3;
  /** 参考朝向（载入静止姿态） */
  quaternion: THREE.Quaternion;
}

/**
 * 找 root motion 载体：动画轨道里被驱动的「最上层节点」。
 * 判据：候选节点 = 轨道命中的节点；若某个候选的祖先也是候选，祖先才是根——
 * 只保留没有候选祖先的那些（通常是唯一的骨架根 / 场景根节点）。
 */
export function findRootMotionNodes(root: THREE.Object3D, clips: THREE.AnimationClip[]): THREE.Object3D[] {
  const candidates = new Set<THREE.Object3D>();
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      if (typeof parsed.nodeName !== 'string' || parsed.nodeName === '') continue;
      const node = THREE.PropertyBinding.findNode(root, parsed.nodeName);
      if (node !== null && node !== undefined) candidates.add(node as THREE.Object3D);
    }
  }
  if (candidates.size === 0) return [];
  const roots: THREE.Object3D[] = [];
  for (const candidate of candidates) {
    let hasAnimatedAncestor = false;
    let parent = candidate.parent;
    while (parent !== null && parent !== undefined) {
      if (candidates.has(parent)) {
        hasAnimatedAncestor = true;
        break;
      }
      parent = parent.parent;
    }
    if (!hasAnimatedAncestor) roots.push(candidate);
  }
  return roots;
}

/** 记录参考姿态（只在载入后调用一次；之后每帧按开关还原） */
export function captureRootPose(nodes: THREE.Object3D[]): RootPoseEntry[] {
  return nodes.map((node) => ({
    node,
    position: node.position.clone(),
    quaternion: node.quaternion.clone(),
  }));
}

/** 按开关把根节点的位移/朝向写回参考值（子节点动画不受影响） */
export function applyRootMotionLock(entries: RootPoseEntry[], lock: RootMotionLock): boolean {
  if (!lock.translation && !lock.rotation) return false;
  for (const entry of entries) {
    if (lock.translation) entry.node.position.copy(entry.position);
    if (lock.rotation) entry.node.quaternion.copy(entry.quaternion);
  }
  return true;
}
