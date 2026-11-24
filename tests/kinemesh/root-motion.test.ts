// root motion 开关（0.9.0）单测：找「最上层被动画节点」、记录参考姿态、按开关只还原根位移/根旋转。
// 真实需求：带位移的动作（冲刺/突进）预览时能原地播放；锁旋转用于 360 转身类动作。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyRootMotionLock,
  captureRootPose,
  findRootMotionNodes,
  ROOT_MOTION_UNLOCKED,
} from '../../plugins/kinemesh/src/core/viewer/root-motion.js';

/** 造一个最小骨架：root 骨（带位移+旋转轨道）→ pelvis 骨（带动画）→ mesh */
function makeRig(): { root: THREE.Object3D; rootBone: THREE.Bone; pelvis: THREE.Bone; clip: THREE.AnimationClip } {
  const root = new THREE.Object3D();
  root.name = 'model';
  const rootBone = new THREE.Bone();
  rootBone.name = 'Bip001';
  const pelvis = new THREE.Bone();
  pelvis.name = 'Bip001_Pelvis';
  rootBone.add(pelvis);
  root.add(rootBone);
  root.updateMatrixWorld(true);
  const clip = new THREE.AnimationClip('Take 001', 1, [
    new THREE.VectorKeyframeTrack('Bip001.position', [0, 1], [0, 0, 0, 100, 0, 0]),
    new THREE.QuaternionKeyframeTrack('Bip001.quaternion', [0, 1], [0, 0, 0, 1, 0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]),
    new THREE.VectorKeyframeTrack('Bip001_Pelvis.position', [0, 1], [0, 0, 0, 0, 10, 0]),
  ]);
  return { root, rootBone, pelvis, clip };
}

describe('找 root motion 载体（findRootMotionNodes）', () => {
  it('只取「最上层的被动画节点」：Bip001 被动画 → pelvis 不算根（它只是子关节）', () => {
    const { root, rootBone, clip } = makeRig();
    const nodes = findRootMotionNodes(root, [clip]);
    expect(nodes).toEqual([rootBone]);
  });

  it('只有子关节动画（根节点没轨道）时，子关节自己就是最上层被动画节点', () => {
    const { root, pelvis } = makeRig();
    const clip = new THREE.AnimationClip('Take 001', 1, [
      new THREE.VectorKeyframeTrack('Bip001_Pelvis.position', [0, 1], [0, 0, 0, 0, 10, 0]),
    ]);
    expect(findRootMotionNodes(root, [clip])).toEqual([pelvis]);
  });

  it('没有动画轨道 → 空数组（纯静态模型，面板据此禁用开关）', () => {
    const { root } = makeRig();
    expect(findRootMotionNodes(root, [])).toEqual([]);
    expect(findRootMotionNodes(root, [new THREE.AnimationClip('empty', 1, [])])).toEqual([]);
  });

  it('多个顶层动画节点（模型根 + 骨骼根都动）都算根', () => {
    const { root, rootBone, clip } = makeRig();
    const extra = new THREE.Object3D();
    extra.name = 'RootNode';
    root.add(extra);
    root.updateMatrixWorld(true);
    const clip2 = new THREE.AnimationClip('Take 002', 1, [
      ...clip.tracks,
      new THREE.VectorKeyframeTrack('RootNode.position', [0, 1], [0, 0, 0, 5, 0, 0]),
    ]);
    const nodes = findRootMotionNodes(root, [clip2]);
    expect(new Set(nodes)).toEqual(new Set([rootBone, extra]));
  });
});

describe('锁定语义（captureRootPose + applyRootMotionLock）', () => {
  it('锁定位移：位置还原为参考值，旋转保留（转身仍生效）', () => {
    const { root, rootBone, clip } = makeRig();
    const pose = captureRootPose(findRootMotionNodes(root, [clip]));
    rootBone.position.set(100, 0, 0);
    rootBone.quaternion.set(0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4));
    applyRootMotionLock(pose, { translation: true, rotation: false });
    expect(rootBone.position.toArray()).toEqual([0, 0, 0]);
    expect(rootBone.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 4), 5); // 旋转没被动
  });

  it('锁定旋转：朝向还原，位置保留（位移仍生效）', () => {
    const { root, rootBone, clip } = makeRig();
    const pose = captureRootPose(findRootMotionNodes(root, [clip]));
    rootBone.position.set(100, 0, 0);
    rootBone.quaternion.set(0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4));
    applyRootMotionLock(pose, { translation: false, rotation: true });
    expect(rootBone.position.x).toBeCloseTo(100, 5);
    expect(rootBone.quaternion.y).toBeCloseTo(0, 5); // 回到初始朝向
  });

  it('两个都锁 = 完全原地；都不锁 = 不动手（返回 false）', () => {
    const { root, rootBone, clip } = makeRig();
    const pose = captureRootPose(findRootMotionNodes(root, [clip]));
    rootBone.position.set(100, 5, 0);
    rootBone.quaternion.set(0, 0.5, 0, 1);
    const changed = applyRootMotionLock(pose, ROOT_MOTION_UNLOCKED);
    expect(changed).toBe(false);
    expect(rootBone.position.x).toBeCloseTo(100, 5);
    applyRootMotionLock(pose, { translation: true, rotation: true });
    expect(rootBone.position.toArray()).toEqual([0, 0, 0]);
    expect(rootBone.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  });

  it('只动根节点：子关节的动画姿势不受影响（否则会变成 T-pose）', () => {
    const { root, rootBone, pelvis, clip } = makeRig();
    const pose = captureRootPose(findRootMotionNodes(root, [clip]));
    rootBone.position.set(100, 0, 0);
    pelvis.position.set(0, 10, 0); // 模拟子关节动画
    applyRootMotionLock(pose, { translation: true, rotation: true });
    expect(pelvis.position.toArray()).toEqual([0, 10, 0]);
  });
});
