// 归一化（design.md §6.2 / 附录 A.0/A.14）：以包围盒身高为 1，速度单位 = 身高/秒。
// 身高拿不到或 ≤ 0 时降级 raw（scale = 1）并给 warning，warning 会透传进 summary。
export type NormalizeMode = 'height' | 'none';

export interface Normalization {
  mode: NormalizeMode;
  /** 长度除以 scale、速度除以 scale；none = 1 */
  scale: number;
  warnings: string[];
}

export function resolveNormalization(requested: NormalizeMode, height: number | null): Normalization {
  if (requested === 'none') {
    return { mode: 'none', scale: 1, warnings: [] };
  }
  if (height === null || !Number.isFinite(height) || height <= 0) {
    return {
      mode: 'none',
      scale: 1,
      warnings: [
        `身高归一不可用（包围盒高度 ${height === null ? '缺失' : height}）：已降级为原始单位（normalize=none），数值不可跨资产比较。`,
      ],
    };
  }
  return { mode: 'height', scale: height, warnings: [] };
}
