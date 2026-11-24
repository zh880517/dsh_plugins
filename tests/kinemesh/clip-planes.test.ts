// 相机裁剪面推导（0.6.8）单测：纯函数模块（core/viewer/clip-planes.ts），Node 直测。
// 钉住这条量化结论：near 决定深度精度，写死 near=0.001 会让厘米级游戏资产的
// 「皮肤 vs 短裤/护膝」两层表面互抢深度（z-fighting → 表面碎成抖动斑点）。
import { describe, expect, it } from 'vitest';
import {
  computeClipPlanes,
  DEPTH_BITS,
  depthResolution,
  FAR_DISTANCE_FACTOR,
  NEAR_DISTANCE_FACTOR,
} from '../../plugins/kinemesh/src/core/viewer/clip-planes.js';

/** 真实资产量级：1005_tacy 身高 ~186 单位，包围球半径 ~93～109，缺省机位距离 = 半径 × 2.2 */
const RADIUS = 100;
const DISTANCE = RADIUS * 2.2;

describe('裁剪面推导：按观察距离缩放', () => {
  it('near/far 跟随距离（near = 距离 × 0.02，far = 距离 × 20）', () => {
    const { near, far } = computeClipPlanes(DISTANCE, RADIUS);
    expect(near).toBeCloseTo(DISTANCE * NEAR_DISTANCE_FACTOR, 6);
    expect(far).toBeCloseTo(DISTANCE * FAR_DISTANCE_FACTOR, 6);
    expect(near).toBeLessThan(DISTANCE);
    expect(far).toBeGreaterThan(DISTANCE + RADIUS);
  });

  it('far/near 比值固定（跨 3 个数量级，深度缓冲精度可控）', () => {
    const { near, far } = computeClipPlanes(DISTANCE, RADIUS);
    expect(far / near).toBeCloseTo(FAR_DISTANCE_FACTOR / NEAR_DISTANCE_FACTOR, 3);
    expect(far / near).toBeLessThan(2000);
  });

  it('拉近拉远都成立（缩放后不会裁掉自身或地面）', () => {
    for (const distance of [RADIUS * 0.3, RADIUS, RADIUS * 5, RADIUS * 40]) {
      const { near, far } = computeClipPlanes(distance, RADIUS);
      expect(near).toBeLessThan(distance);
      // far 至少留到 20 倍半径：地面网格按模型半径缩放，拉到很远也不能被裁掉
      expect(far).toBeGreaterThanOrEqual(RADIUS * 20 - 1e-9);
    }
  });

  it('超小模型也不至于 near 穿透模型（near 有半径兜底）', () => {
    const tiny = computeClipPlanes(1e-9, 1e-9);
    expect(tiny.near).toBeGreaterThan(0);
    expect(tiny.far).toBeGreaterThan(tiny.near);
  });

  it('非法入参（0 / 负数 / NaN）不产生非有限值', () => {
    for (const [distance, radius] of [
      [0, RADIUS],
      [-1, RADIUS],
      [Number.NaN, Number.NaN],
      [DISTANCE, 0],
    ]) {
      const { near, far } = computeClipPlanes(distance, radius);
      expect(Number.isFinite(near)).toBe(true);
      expect(Number.isFinite(far)).toBe(true);
      expect(near).toBeGreaterThan(0);
      expect(far).toBeGreaterThan(near);
    }
  });
});

describe('深度精度：能分开皮肤与衣服（0.2 单位级层差）', () => {
  it('24 位深度缓冲公式自洽', () => {
    expect(DEPTH_BITS).toBe(24);
    expect(depthResolution(100, 2)).toBeCloseTo((100 * 100) / (2 * 2 ** 24), 12);
  });

  it('旧配置（near=0.001）在距离 220 处的可分辨厚度 > 1 单位 → 必然 z-fighting', () => {
    expect(depthResolution(DISTANCE, 0.001)).toBeGreaterThan(1);
  });

  it('新配置同一位置的可分辨厚度 < 0.01 单位 → 0.2 单位的层差能稳定分层', () => {
    const { near } = computeClipPlanes(DISTANCE, RADIUS);
    const resolution = depthResolution(DISTANCE, near);
    expect(resolution).toBeLessThan(0.01);
    // 取整前的余量：至少要能分开 0.1 单位厚的两层表面
    expect(resolution).toBeLessThan(0.1);
  });
});
