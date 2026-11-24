// 预览光照强度表（0.6.7）单测：纯数据模块（core/viewer/lighting.ts），Node 直测。
// 目的：把「素模别被打爆成纯白」的量化结论钉住——0.6.6 的纯白 bug 就是素模沿用了
// 贴图布光的 8.4 合计强度，Lambert 受光面整块截断（实测 69% 模型像素 ≥250）。
import { describe, expect, it } from 'vitest';
import type { ViewMode } from '../../plugins/kinemesh/src/core/viewstate.js';
import {
  lightRigFor,
  lightRigTotal,
  SOLID_LIGHT_RIG,
  SOLID_MATERIAL_COLOR,
  TEXTURED_LIGHT_RIG,
  type LightRig,
} from '../../plugins/kinemesh/src/core/viewer/lighting.js';

/** 实测阈值：合计 ≥4.5 素模回到纯白；<3 整具模型发灰发闷（见 lighting.ts 注释） */
const SOLID_TOTAL_MAX = 4.5;
const SOLID_TOTAL_MIN = 3;

const allRigs: Array<[string, LightRig]> = [
  ['贴图布光', TEXTURED_LIGHT_RIG],
  ['素模布光', SOLID_LIGHT_RIG],
];

describe('光照强度表：模式分派', () => {
  it('solid 用素模布光', () => {
    expect(lightRigFor('solid')).toBe(SOLID_LIGHT_RIG);
  });

  it('贴图 / 线框 / 骨骼模式沿用 0.6.4 贴图布光（素模改动不波及它们）', () => {
    const modes: ViewMode[] = ['default', 'wireframe', 'skeleton', 'bones-overlay'];
    for (const mode of modes) expect(lightRigFor(mode)).toBe(TEXTURED_LIGHT_RIG);
  });
});

describe('光照强度表：素模布光不会过曝', () => {
  it('合计强度落在实测可用区间（3 ～ 4.5）', () => {
    const total = lightRigTotal(SOLID_LIGHT_RIG);
    expect(total).toBeGreaterThanOrEqual(SOLID_TOTAL_MIN);
    expect(total).toBeLessThanOrEqual(SOLID_TOTAL_MAX);
  });

  it('主光挑起形体：强度明显大于环境光（否则整具模型发平、明暗差 <10 级）', () => {
    expect(SOLID_LIGHT_RIG.key).toBeGreaterThan(SOLID_LIGHT_RIG.ambient * 4);
    expect(SOLID_LIGHT_RIG.key).toBeGreaterThan(SOLID_LIGHT_RIG.hemi);
  });

  it('素模合计强度远小于贴图布光（这就是旧版纯白的来源）', () => {
    expect(lightRigTotal(SOLID_LIGHT_RIG)).toBeLessThan(lightRigTotal(TEXTURED_LIGHT_RIG) / 2);
  });
});

describe('光照强度表：贴图布光数值锁定（0.6.4 量化调参，别按物理正确去改）', () => {
  it('五项强度保持 0.6.4 的值', () => {
    expect(TEXTURED_LIGHT_RIG.ambient).toBe(2.6);
    expect(TEXTURED_LIGHT_RIG.hemi).toBe(2.4);
    expect(TEXTURED_LIGHT_RIG.key).toBe(1.7);
    expect(TEXTURED_LIGHT_RIG.fill).toBe(1.0);
    expect(TEXTURED_LIGHT_RIG.rim).toBe(0.7);
  });
});

describe('光照强度表：通用约束', () => {
  it('所有强度都是正数（漏写会使灯完全不出光）', () => {
    for (const [name, rig] of allRigs) {
      for (const [channel, value] of Object.entries(rig)) {
        expect(value, `${name}.${channel}`).toBeGreaterThan(0);
        expect(Number.isFinite(value), `${name}.${channel}`).toBe(true);
      }
    }
  });

  it('素模基色是中性浅灰（约 0xd2d6db，贴近常规 3D 工具默认素模色）', () => {
    const r = (SOLID_MATERIAL_COLOR >> 16) & 0xff;
    const g = (SOLID_MATERIAL_COLOR >> 8) & 0xff;
    const b = SOLID_MATERIAL_COLOR & 0xff;
    for (const channel of [r, g, b]) {
      expect(channel).toBeGreaterThanOrEqual(0xb0);
      expect(channel).toBeLessThanOrEqual(0xe8);
    }
    // 中性：三通道差异不超过 12
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(12);
  });
});
