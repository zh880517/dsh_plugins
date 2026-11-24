// 辅助对象过滤（0.6.6，纯函数、Node 可测）：Unity/Max 导出的 FBX 常带 Dummy、locator、
// IK 目标、线框 gizmo、相机辅助物；常规 3D 工具（Maya/Blender/Unity）默认不显示这些，
// 预览里却会变成虚线、尖刺、红绿轴等杂线。这里只识别、不修改——由 viewer 载入时统一隐藏。
// 骨骼（Bone）永不进入名单：蒙皮依赖骨骼层级；网格是要看的本体，也不动。
import type * as THREE from 'three';

/** 这些 three 对象类型在 3D 软件里都属于「辅助显示」 */
const AUX_OBJECT_TYPES = new Set(['Line', 'LineSegments', 'LineLoop', 'Points', 'Sprite', 'Camera', 'Light']);

/** 名字里带这些词的通常是 Dummy / locator / IK 目标 / 碰撞体 / 参考物（按词边界匹配，避免误伤 helmet 等） */
const AUX_NAME_PATTERN = /(?:^|[^a-z])(dummy|helper|locator|marker|gizmo|collider|probe|reference|placeholder)(?:$|[^a-z])/i;

/** 判断单个对象是否为辅助对象（骨骼一律 false） */
export function isAuxiliaryObject(object: THREE.Object3D): boolean {
  if ((object as THREE.Bone).isBone === true) return false;
  if (AUX_OBJECT_TYPES.has(object.type)) return true;
  return object.name !== '' && AUX_NAME_PATTERN.test(object.name);
}

/** 收集整棵树里的辅助对象（保持遍历顺序；调用方负责隐藏） */
export function collectAuxiliaryObjects(root: THREE.Object3D): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  root.traverse((child) => {
    if (child !== root && isAuxiliaryObject(child)) found.push(child);
  });
  return found;
}
