// 骨架线生命周期（0.6.9）单测：纯对象操作模块（core/viewer/skeleton-helpers.ts），Node 直测。
// 钉住这条回归：SkeletonHelper 挂在 scene 上，卸载模型时必须从 scene 摘掉——
// 漏摘时 skeleton / bones-overlay 模式「换 FBX 后残留旧骨架」（真实资产实测：换模型后
// 画面多出 4740 个像素的旧骨架线段，与「全新载入」对照图不一致）。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  attachSkeletonHelpers,
  createSkeletonHelpers,
  detachSkeletonHelpers,
} from '../../plugins/kinemesh/src/core/viewer/skeleton-helpers.js';

/** 造一个最小骨架（两段骨 + 根对象），SkeletonHelper 只需要能 traverse 到 isBone */
function makeRig(name: string): THREE.Object3D {
  const root = new THREE.Object3D();
  root.name = name;
  const hip = new THREE.Bone();
  hip.name = `${name}-hip`;
  hip.position.set(0, 1, 0);
  const spine = new THREE.Bone();
  spine.name = `${name}-spine`;
  spine.position.set(0, 0.5, 0);
  hip.add(spine);
  root.add(hip);
  root.updateMatrixWorld(true);
  return root;
}

describe('骨架线：建 / 挂 / 摘', () => {
  it('新建的骨架线默认隐藏（由 applyMode 按模式显示）', () => {
    const helpers = createSkeletonHelpers(makeRig('rig'));
    expect(helpers).toHaveLength(1);
    expect(helpers[0]?.visible).toBe(false);
  });

  it('挂到 scene 后成为场景子节点（不在 model 层级里）', () => {
    const scene = new THREE.Scene();
    const helpers = createSkeletonHelpers(makeRig('rig'));
    attachSkeletonHelpers(scene, helpers);
    expect(scene.children).toContain(helpers[0]);
  });

  it('摘除必须从 scene 移除——否则旧骨架会画在下一个模型上（0.6.9 回归点）', () => {
    const scene = new THREE.Scene();
    const helpers = createSkeletonHelpers(makeRig('rig'));
    attachSkeletonHelpers(scene, helpers);
    detachSkeletonHelpers(scene, helpers);
    expect(scene.children).not.toContain(helpers[0]);
    expect(scene.children).toHaveLength(0);
  });

  it('连续两代模型：第一代摘除后场景里只剩新骨架（换 FBX 不残留）', () => {
    const scene = new THREE.Scene();
    const generation1 = createSkeletonHelpers(makeRig('first'));
    attachSkeletonHelpers(scene, generation1);
    detachSkeletonHelpers(scene, generation1);
    const generation2 = createSkeletonHelpers(makeRig('second'));
    attachSkeletonHelpers(scene, generation2);
    expect(scene.children).toHaveLength(1);
    expect(scene.children[0]).toBe(generation2[0]);
  });

  it('重复摘除不抛错（dispose 之后再 dispose 是幂等的）', () => {
    const scene = new THREE.Scene();
    const helpers = createSkeletonHelpers(makeRig('rig'));
    attachSkeletonHelpers(scene, helpers);
    detachSkeletonHelpers(scene, helpers);
    expect(() => detachSkeletonHelpers(scene, helpers)).not.toThrow();
  });

  it('空清单是安全的（静态模型没有骨架线）', () => {
    const scene = new THREE.Scene();
    expect(() => attachSkeletonHelpers(scene, [])).not.toThrow();
    expect(() => detachSkeletonHelpers(scene, [])).not.toThrow();
    expect(scene.children).toHaveLength(0);
  });
});
