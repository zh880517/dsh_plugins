// scene-info 贴图提取回归（真实 FBX 贴图节点）：three r155+ 的 Texture.DEFAULT_IMAGE = null，
// node 端贴图桩不解码位图 → texture.image = null；旧实现 null.width 直接抛 TypeError，
// 导致带贴图的真实 FBX 全部 info 失败（合成 fixture 无贴图节点，测试从未红过）。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { sceneToInfo } from '../../plugins/kinemesh/src/core/analyze/scene-info.js';
import type { CanonicalScene } from '../../plugins/kinemesh/src/core/types.js';

function sceneWithMap(map: THREE.Texture | undefined): CanonicalScene {
  const material = new THREE.MeshStandardMaterial();
  if (map !== undefined) material.map = map;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  return {
    object: mesh,
    animations: [],
    meta: { format: 'fbx-binary', unitScaleFactor: null, upAxis: 'y', fps: null },
  };
}

describe('scene-info · collectTextures 对 stub/未解码贴图健壮（真实 FBX 贴图节点回归）', () => {
  it('texture.image = null（node 贴图桩产物）→ 不抛错、size 报 null、embedded 标注', () => {
    const texture = new THREE.Texture(); // DEFAULT_IMAGE = null
    texture.name = 'hero_diff.png';
    texture.userData.kinemeshUnresolved = true;
    const info = sceneToInfo(sceneWithMap(texture), { fileName: 'attack_00.fbx', fileSize: 1, expectsAnimation: true });
    expect(info.textures).toHaveLength(1);
    expect(info.textures[0]).toMatchObject({ name: 'hero_diff.png', size: null, embedded: true });
  });

  it('已解码贴图（image 带 width/height）→ 报像素尺寸', () => {
    const texture = new THREE.Texture({ width: 512, height: 512 });
    texture.name = 'hero_diff.png';
    const info = sceneToInfo(sceneWithMap(texture), { fileName: 'x.fbx', fileSize: 1, expectsAnimation: false });
    expect(info.textures[0]).toMatchObject({ size: [512, 512] });
  });

  it('无贴图材质 → textures 空数组', () => {
    const info = sceneToInfo(sceneWithMap(undefined), { fileName: 'x.fbx', fileSize: 1, expectsAnimation: false });
    expect(info.textures).toEqual([]);
  });
});
