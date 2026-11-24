// 相机裁剪面推导（0.6.8）：纯函数，不 import three / DOM，Node 直测。
//
// 背景：mountViewer 原先把 near/far 写死成 0.001 / 1_000_000（跨 9 个数量级）。
// 透视投影的深度缓冲精度几乎只由 near 决定——24 位深度在距离 z 处的可分辨厚度约为
//   Δz ≈ z² / (near · 2^24)
// 代入 near=0.001、z=200（厘米级游戏资产，身高 186 单位）：Δz ≈ 2.4 单位。
// 而这类资产里「皮肤 vs 短裤/护膝」两层表面只差 0.1～0.3 单位 → 两层互抢深度，
// 表面碎成明暗抖动斑点（0.6.7 交验实测：模型像素里 1.4% 是这种孤立斑点，播放下抖动最明显）。
//
// 修法：裁剪面按观察距离走，near = distance × 0.02、far = distance × 20（跨 3 个数量级），
// 同一位置的可分辨厚度降到 0.001 单位量级，多层表面正常分层（实测斑点降到 0.6%，
// 剩下的属于模型自身的层叠/接缝，与深度无关）。
export const DEPTH_BITS = 24;

/** near = 观察距离 × 该系数（0.02 → far/near 跨 3 个数量级，精度足够分 0.001 单位级的层） */
export const NEAR_DISTANCE_FACTOR = 0.02;
/** far = 观察距离 × 该系数（留足背景网格/远处几何，不至于裁掉地面） */
export const FAR_DISTANCE_FACTOR = 20;

export interface ClipPlanes {
  near: number;
  far: number;
}

/**
 * 按「相机到注视点的距离」和「模型包围球半径」推导裁剪面。
 * 兜底：near 不小于半径的 1e-5（超小模型也不至于裁剪穿过模型）、far 至少覆盖 20 倍半径（地面网格常在模型半径量级）。
 */
export function computeClipPlanes(distance: number, radius: number): ClipPlanes {
  const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 1e-6;
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 1e-6;
  const near = Math.max(safeDistance * NEAR_DISTANCE_FACTOR, safeRadius * 1e-5);
  const far = Math.max(safeDistance * FAR_DISTANCE_FACTOR, safeRadius * FAR_DISTANCE_FACTOR, near * 1000);
  return { near, far };
}

/** 24 位深度缓冲在距离 z 处的可分辨厚度（世界单位，近似值；越大越容易 z-fighting） */
export function depthResolution(z: number, near: number): number {
  if (!(z > 0) || !(near > 0)) return Number.POSITIVE_INFINITY;
  return (z * z) / (near * 2 ** DEPTH_BITS);
}
