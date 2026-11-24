// 角色根节点 XYZ 参考轴（0.9.1）单测：三轴线/配色、跟随根节点世界变换、开关隐藏。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRootAxes } from '../../plugins/kinemesh/src/core/viewer/root-axes.js';
import { AXIS_COLORS } from '../../plugins/kinemesh/src/core/viewer/axes.js';

describe('角色根节点参考轴（createRootAxes）', () => {
  it('三根单位轴线：X/Y/Z 各一根，配色沿用全局轴（X 红 / Y 绿 / Z 蓝）', () => {
    const axes = createRootAxes();
    const lines = axes.group.children.filter((child) => (child as THREE.Line).isLine) as THREE.Line[];
    expect(lines).toHaveLength(3);
    const colors = lines.map((line) => (line.material as THREE.LineBasicMaterial).color.getHex());
    expect(colors).toEqual([AXIS_COLORS.x, AXIS_COLORS.y, AXIS_COLORS.z]);
    // 单位长度建模，靠 group.scale 换算世界长度
    const end = lines[0]!.geometry.getAttribute('position');
    expect([end.getX(1), end.getY(1), end.getZ(1)]).toEqual([1, 0, 0]);
  });

  it('默认隐藏（没有根节点时不应出现在画面里）', () => {
    const axes = createRootAxes();
    expect(axes.group.visible).toBe(false);
  });

  it('update(null, …) 保持隐藏（无模型/无根节点）', () => {
    const axes = createRootAxes();
    axes.update(null, 10);
    expect(axes.group.visible).toBe(false);
  });

  it('update 跟随根节点的世界位置/朝向，缩放 = 轴长', () => {
    const parent = new THREE.Object3D();
    parent.position.set(100, 0, 0);
    parent.rotation.y = Math.PI / 2;
    const root = new THREE.Object3D();
    root.name = 'root';
    root.position.set(0, 5, 0);
    parent.add(root);
    parent.updateMatrixWorld(true);

    const axes = createRootAxes();
    axes.update(root, 20);
    expect(axes.group.visible).toBe(true);
    expect(axes.group.position.toArray()).toEqual([100, 5, 0]); // 世界坐标
    expect(axes.group.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 4), 5); // 继承父级旋转
    expect(axes.group.scale.x).toBeCloseTo(20, 5); // 轴长
  });

  it('轴线 depthTest 关闭（根节点常在模型体内，否则完全看不见）', () => {
    const axes = createRootAxes();
    for (const child of axes.group.children) {
      if ((child as THREE.Line).isLine) expect((child as any).material.depthTest).toBe(false);
    }
  });
});
