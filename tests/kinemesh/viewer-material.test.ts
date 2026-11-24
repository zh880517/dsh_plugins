// 预览材质兜底（0.6.4）单测：真实 Unity/Max 导出资产在预览里呈纯黑剪影的两种成因。
// 纯函数模块（core/viewer/material.ts），不依赖 WebGL，Node 直测。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  normalizePreviewMaterial,
  PREVIEW_FALLBACK_COLOR,
  PREVIEW_METALNESS_MAX,
  PREVIEW_ROUGHNESS_MIN,
} from '../../plugins/kinemesh/src/core/viewer/material.js';

describe('预览材质兜底：metalness 过高（物理光照 + 无环境贴图 = 纯黑）', () => {
  it('metalness 1.0 → 降到上限，并把 roughness 抬到下限', () => {
    const material = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.2 });
    expect(normalizePreviewMaterial(material)).toBe(true);
    expect(material.metalness).toBe(PREVIEW_METALNESS_MAX);
    expect(material.roughness).toBe(PREVIEW_ROUGHNESS_MIN);
  });

  it('metalness 已低（0.1）不动；Phong 材质没有 metalness 字段也不受影响', () => {
    const standard = new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.5 });
    expect(normalizePreviewMaterial(standard)).toBe(false);
    expect(standard.metalness).toBe(0.1);

    const phong = new THREE.MeshPhongMaterial({ color: 0x8899aa });
    expect(normalizePreviewMaterial(phong)).toBe(false);
    expect(phong.color.getHex()).toBe(0x8899aa);
  });
});

describe('预览材质兜底：纯黑材质（贴图缺失/解码失败）', () => {
  it('无贴图 + 纯黑 → 中性灰兜底', () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x000000 });
    expect(normalizePreviewMaterial(material)).toBe(true);
    expect(material.color.getHex()).toBe(PREVIEW_FALLBACK_COLOR);
  });

  it('贴图对象在但 image 为空（解码失败）→ 同样按无贴图兜底', () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x000000 });
    material.map = new THREE.Texture(); // DEFAULT_IMAGE = null
    expect(normalizePreviewMaterial(material)).toBe(true);
    expect(material.color.getHex()).toBe(PREVIEW_FALLBACK_COLOR);
  });

  it('有可用贴图时不动颜色（贴图能给形状上色，不必灰底）', () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x000000 });
    material.map = new THREE.Texture({ width: 4, height: 4 });
    expect(normalizePreviewMaterial(material)).toBe(false);
    expect(material.color.getHex()).toBe(0x000000);
  });

  it('正常亮色材质不动', () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    expect(normalizePreviewMaterial(material)).toBe(false);
    expect(material.color.getHex()).toBe(0x8899aa);
  });

  it('接近黑但不是纯黑（0x0a0a0a）也兜底：深色舞台上看不清', () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x0a0a0a });
    expect(normalizePreviewMaterial(material)).toBe(true);
    expect(material.color.getHex()).toBe(PREVIEW_FALLBACK_COLOR);
  });
});
