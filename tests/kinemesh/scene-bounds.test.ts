// 身体包围盒（0.8.0）单测：截图取景要用「当前帧」包围盒，而不是载入时的静止包围盒。
// 真实问题：带 root motion 的 action（1012_tahlia attack_01）用静止包围盒取景，
// 第 36 帧角色冲到镜头前只剩半截身体（用户反馈「截图默认截取不到」）。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { boundsOfBox, currentPoseBounds, currentPoseBoundsInfo } from '../../plugins/kinemesh/src/core/viewer/scene-bounds.js';

function meshAt(geometry: THREE.BufferGeometry, position: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.position.set(position[0], position[1], position[2]);
  return mesh;
}

describe('当前姿态包围盒（currentPoseBounds）', () => {
  it('普通网格：按 matrixWorld 把几何包围盒搬到世界坐标', () => {
    const root = new THREE.Object3D();
    root.add(meshAt(new THREE.BoxGeometry(2, 2, 2), [10, 0, 0]));
    const info = currentPoseBoundsInfo(root);
    expect(info).not.toBeNull();
    expect(info?.center[0]).toBeCloseTo(10, 5);
    expect(info?.center[1]).toBeCloseTo(0, 5);
    expect(info?.radius).toBeGreaterThan(1);
  });

  it('两个网格：并集（位移后的身体 + 举起的武器都要算进去）', () => {
    const root = new THREE.Object3D();
    root.add(meshAt(new THREE.BoxGeometry(1, 1, 1), [0, 0, 0]));
    root.add(meshAt(new THREE.BoxGeometry(1, 1, 1), [5, 3, 0]));
    const box = currentPoseBounds(root);
    expect(box).not.toBeNull();
    expect(box?.min.x).toBeCloseTo(-0.5, 5);
    expect(box?.max.x).toBeCloseTo(5.5, 5);
    expect(box?.max.y).toBeCloseTo(3.5, 5);
  });

  it('父节点带位移/缩放也算进去（root motion 常挂在父级）', () => {
    const root = new THREE.Object3D();
    root.position.set(100, 0, 0);
    root.scale.setScalar(2);
    root.add(meshAt(new THREE.BoxGeometry(1, 1, 1), [0, 0, 0]));
    const info = currentPoseBoundsInfo(root);
    expect(info?.center[0]).toBeCloseTo(100, 5);
    expect(info?.radius).toBeCloseTo(Math.sqrt(3) / 2 * 2 / 2 * 2, 5); // 2 倍缩放的立方体
  });

  it('隐藏对象跳过（辅助对象过滤后的 Dummy/locator 不应撑大包围盒）', () => {
    const root = new THREE.Object3D();
    root.add(meshAt(new THREE.BoxGeometry(1, 1, 1), [0, 0, 0]));
    const hidden = meshAt(new THREE.BoxGeometry(100, 100, 100), [500, 0, 0]);
    hidden.visible = false;
    root.add(hidden);
    const box = currentPoseBounds(root);
    expect(box?.max.x).toBeCloseTo(0.5, 5);
  });

  it('没有可见网格返回 null（纯骨架模型）', () => {
    const root = new THREE.Object3D();
    root.add(new THREE.Bone());
    expect(currentPoseBounds(root)).toBeNull();
    expect(currentPoseBoundsInfo(root)).toBeNull();
  });

  it('boundsOfBox：空盒 null；radius 是空间对角线一半（与既有口径一致）', () => {
    expect(boundsOfBox(new THREE.Box3())).toBeNull();
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const info = boundsOfBox(box);
    expect(info?.radius).toBeCloseTo(Math.sqrt(12) / 2, 5);
    expect(info?.center).toEqual([0, 0, 0]);
  });
});
