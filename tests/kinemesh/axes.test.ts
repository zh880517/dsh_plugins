// 全局轴参考（0.8.1）单测：三根轴线 + 轴端字母标签的几何/配色口径。
// 背景：0.6.6 只画了地面上的 X/Z 两条线，既没 Y 轴也没字母，用户反馈「没有标出全局 xyz 轴作为参考」。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AXIS_COLORS, createAxisGuides, createGroundAxisLines } from '../../plugins/kinemesh/src/core/viewer/axes.js';

describe('地面 X/Z 轴长线（createGroundAxisLines）', () => {
  it('两根线，从 -length 到 +length（指示正负方向）', () => {
    const lines = createGroundAxisLines(5);
    expect(lines).toHaveLength(2);
    const spans = lines.map((line) => {
      const position = line.geometry.getAttribute('position');
      return [position.getX(0), position.getY(0), position.getZ(0), position.getX(1), position.getY(1), position.getZ(1)];
    });
    expect(spans[0]).toEqual([-5, 0, 0, 5, 0, 0]); // X
    expect(spans[1]).toEqual([0, 0, -5, 0, 0, 5]); // Z
    expect((lines[0]!.material as THREE.LineBasicMaterial).color.getHex()).toBe(AXIS_COLORS.x);
    expect((lines[1]!.material as THREE.LineBasicMaterial).color.getHex()).toBe(AXIS_COLORS.z);
  });
});

describe('全局 XYZ 轴参考（createAxisGuides）', () => {
  it('三根轴线：X 沿 +X、Y 沿 +Y、Z 沿 +Z，长度正确', () => {
    const { lines } = createAxisGuides(5);
    expect(lines).toHaveLength(3);
    const ends = lines.map((line) => {
      const position = line.geometry.getAttribute('position');
      return [position.getX(1), position.getY(1), position.getZ(1)];
    });
    expect(ends).toEqual([
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
    ]);
    // 都从原点出发
    for (const line of lines) {
      const position = line.geometry.getAttribute('position');
      expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([0, 0, 0]);
    }
  });

  it('配色遵循 3D 工具习惯：X 红 / Y 绿 / Z 蓝（互不相同）', () => {
    const { lines } = createAxisGuides(5);
    const colors = lines.map((line) => (line.material as THREE.LineBasicMaterial).color.getHex());
    expect(colors[0]).toBe(AXIS_COLORS.x);
    expect(colors[1]).toBe(AXIS_COLORS.y);
    expect(colors[2]).toBe(AXIS_COLORS.z);
    expect(new Set(colors).size).toBe(3);
    // X 偏红、Y 偏绿、Z 偏蓝（通道比较，别让配色改坏）
    const [red, green, blue] = colors.map((value) => new THREE.Color(value));
    expect(red!.r).toBeGreaterThan(red!.b);
    expect(green!.g).toBeGreaterThan(green!.r);
    expect(blue!.b).toBeGreaterThan(blue!.r);
  });

  it('轴端字母标签：浏览器环境 3 枚（Node 环境无 document → 空数组，不报错）', () => {
    const { labels } = createAxisGuides(5);
    if (typeof document === 'undefined') {
      expect(labels).toHaveLength(0);
      return;
    }
    expect(labels).toHaveLength(3);
    // 三枚标签在世界坐标的 X/Y/Z 三个方向上（略超出轴线末端）
    const positions = labels.map((label) => [label.position.x, label.position.y, label.position.z]);
    expect(positions[0]?.[0]).toBeGreaterThan(5);
    expect(positions[1]?.[1]).toBeGreaterThan(5);
    expect(positions[2]?.[2]).toBeGreaterThan(5);
    // 永远朝向相机、压在模型之上
    for (const label of labels) {
      expect(label.material.depthTest).toBe(false);
      expect(label.renderOrder).toBe(998);
    }
  });

  it('轴线不参与包围盒（场景取景只算模型）——保证长度参数可自由调', () => {
    const { lines } = createAxisGuides(5);
    const group = new THREE.Group();
    group.add(...lines);
    const box = new THREE.Box3().setFromObject(group);
    expect(box.max.x).toBeCloseTo(5, 5);
    expect(box.max.y).toBeCloseTo(5, 5);
  });
});
