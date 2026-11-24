// 场景/身体包围盒（0.8.0）：截图取景与「跟位移」都靠它。
//
// 为什么不能只用载入时的 Box3：那是**静止姿态**（bind/首帧）的包围盒。带 root motion 的
// 动作（冲刺、突进、跳跃位移）整具身体会跑到别处，用静止包围盒算出的默认机位就会：
//   · 角色跑近镜头 → 只剩半截身体（真实资产 1012_tahlia attack_01 第 36 帧就是这样）；
//   · 角色跑远     → 画面里只剩地面网格。
// 所以这里提供「按当前帧蒙皮结果算包围盒」的实现：SkinnedMesh.computeBoundingBox() 会把蒙皮
// 位移算进去（three 内部按骨骼矩阵变换每个顶点），再乘 mesh.matrixWorld 得到世界坐标。
//
// 纯对象操作（不碰 WebGL），Node 端可用真实 THREE 对象直测。
import * as THREE from 'three';

/**
 * 当前姿态下的可见网格包围盒（世界坐标）。
 * · 蒙皮网格：走 `computeBoundingBox()`（含蒙皮变形），再乘 matrixWorld；
 * · 普通网格：geometry.boundingBox 乘 matrixWorld；
 * · 隐藏对象（辅助对象过滤等）跳过：用 `traverseVisible`。
 * 没有任何可见网格时返回 null。
 */
export function currentPoseBounds(root: THREE.Object3D): THREE.Box3 | null {
  const box = new THREE.Box3();
  let found = false;
  root.updateMatrixWorld(true);
  root.traverseVisible((child) => {
    const mesh = child as THREE.Mesh & { isSkinnedMesh?: boolean; computeBoundingBox?: () => void };
    if (mesh.isMesh !== true) return;
    const local = new THREE.Box3();
    if (mesh.isSkinnedMesh === true && typeof mesh.computeBoundingBox === 'function') {
      // 蒙皮包围盒（局部空间，已按骨骼变形）——每次都要重算，骨骼姿态在变
      mesh.computeBoundingBox();
      const skinned = mesh as unknown as { boundingBox: THREE.Box3 | null };
      if (skinned.boundingBox === null || skinned.boundingBox.isEmpty()) return;
      local.copy(skinned.boundingBox);
    } else {
      if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
      const geometryBox = mesh.geometry.boundingBox;
      if (geometryBox === null || geometryBox.isEmpty()) return;
      local.copy(geometryBox);
    }
    box.union(local.applyMatrix4(mesh.matrixWorld));
    found = true;
  });
  return found ? box : null;
}

/** 包围盒 → { center, radius }（radius = 空间对角线一半，与 viewer 的既有口径一致） */
export function boundsOfBox(box: THREE.Box3 | null): { center: [number, number, number]; radius: number } | null {
  if (box === null || box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return {
    center: [center.x, center.y, center.z],
    radius: Math.max(size.length() / 2, 0.001),
  };
}

/** 当前姿态包围盒（一步到位版） */
export function currentPoseBoundsInfo(root: THREE.Object3D): { center: [number, number, number]; radius: number } | null {
  return boundsOfBox(currentPoseBounds(root));
}
