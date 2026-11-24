// 预览光照强度表（design.md §6.10.4）：纯数据 + 纯函数，不 import three，
// 可在 Node 测试里断言「不会把素模打爆成纯白」。
//
// 为什么两套：
// · 贴图模式（0.6.4）为救深色贴图的 Unity/Max 资产，四向布光强度合计 8.4（远大于 1）——
//   贴图本身暗，靠过曝把细节抬出来，深色资产的明暗差反而更清楚。
// · solid 素模模式（0.6.7）材质是 Lambert：出射亮度 ≈ albedo × Σ(强度 × NdotL)，合计一超过 1
//   就整块截断。素模沿用贴图布光的结果是纯白色块（0.6.6 实测 69% 模型像素 ≥250，用户反馈「又变成纯白」），
//   所以单独一套 studio 布光：主光挑起形体，环境/半球只做暗部托底。
import type { ViewMode } from '../viewstate.js';

export interface LightRig {
  /** AmbientLight（均匀托底，无方向） */
  ambient: number;
  /** HemisphereLight（天空/地面色上亮下暗，给上下层次） */
  hemi: number;
  /** 主方向光（右上前方） */
  key: number;
  /** 侧上补光（左后方，防止暗侧纯黑） */
  fill: number;
  /** 底部轮廓光（压低背景交界处） */
  rim: number;
}

/**
 * 贴图模式布光（0.6.4，数值刻意过大，别按物理正确去"修"）：
 * 合计 8.4 是量化调出来的——Unity/Max 导出的深色贴图资产在深色舞台上看它是黑剪影。
 */
export const TEXTURED_LIGHT_RIG: LightRig = { ambient: 2.6, hemi: 2.4, key: 1.7, fill: 1.0, rim: 0.7 };

/**
 * solid 素模布光（0.6.7）：常规 3D 工具的 studio 观感。
 * 实测（1005_tacy attack_00/04，900×900，three r187，无 tone mapping）：
 *   素模像素 mean≈172～179、p99≈212～214、≥250 占比 0%（旧共享布光是 mean 248 / 69% 截断）。
 * 调参铁律：合计 ≥4.5 就回到纯白；<3 则整具模型发灰发闷（明暗差 <10 级）。
 */
export const SOLID_LIGHT_RIG: LightRig = { ambient: 0.32, hemi: 0.75, key: 2.2, fill: 0.45, rim: 0.38 };

/** solid 素模的共享材质基色：中性浅灰，贴近常规 3D 工具的默认素模色 */
export const SOLID_MATERIAL_COLOR = 0xd2d6db;

/** 按渲染模式选光照强度：只有 solid 用素模布光，其余模式（贴图 / 线框 / 骨骼）沿用 0.6.4 贴图布光 */
export function lightRigFor(mode: ViewMode): LightRig {
  return mode === 'solid' ? SOLID_LIGHT_RIG : TEXTURED_LIGHT_RIG;
}

/** 光照强度合计（测试用：判断「会不会过曝」的口径） */
export function lightRigTotal(rig: LightRig): number {
  return rig.ambient + rig.hemi + rig.key + rig.fill + rig.rim;
}
