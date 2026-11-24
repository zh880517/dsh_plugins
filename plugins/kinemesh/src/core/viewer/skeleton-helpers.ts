// 骨架线（SkeletonHelper）生命周期（0.6.9）：纯对象操作，不碰 WebGL，Node 直测。
//
// 为什么单独一个模块：SkeletonHelper 必须挂在 **scene** 上（它自己维护一份骨骼线段几何，
// 不能作为 model 的子节点，否则会被包围盒/可见性/材质替换逻辑牵连）。挂在 scene 上就意味着
// 卸载模型时得自己摘——漏了这一步，旧骨架会继续画在下一个模型上（skeleton / bones-overlay
// 模式「换 FBX 后残留旧骨架」就是这么来的）。
import * as THREE from 'three';

/** 为刚载入的模型建骨架线（先隐藏，由 applyMode 按模式显示） */
export function createSkeletonHelpers(root: THREE.Object3D): THREE.SkeletonHelper[] {
  const helper = new THREE.SkeletonHelper(root);
  helper.visible = false;
  return [helper];
}

/** 挂到场景（scene 级，不在 model 层级里） */
export function attachSkeletonHelpers(scene: THREE.Object3D, helpers: THREE.SkeletonHelper[]): void {
  for (const helper of helpers) scene.add(helper);
}

/** 卸载模型时摘除并释放：必须从 scene 移除，否则残留旧骨架（0.6.9 修复） */
export function detachSkeletonHelpers(scene: THREE.Object3D, helpers: THREE.SkeletonHelper[]): void {
  for (const helper of helpers) {
    scene.remove(helper);
    helper.geometry.dispose();
    const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
    for (const material of materials) {
      if (material !== undefined && material !== null) material.dispose();
    }
  }
}
