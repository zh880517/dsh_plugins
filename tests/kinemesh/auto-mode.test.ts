// 载入自动选模式（0.7.1）单测：纯判定模块（core/viewer/auto-mode.ts），Node 直测。
// 规则：无 mesh → skeleton；有 mesh 无可用贴图 → solid；有可用贴图 → default。
// 真实场景来源：纯骨架 FBX（只有 Bone）、Unity/Max 导出的无贴图网格、贴图解码失败（image 为 null）、
// 以及素模模式下 mesh.material 已被换掉但真实材质留在 userData 里。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  collectSceneModeFacts,
  materialHasUsableTexture,
  suggestModeFromFacts,
  suggestViewMode,
} from '../../plugins/kinemesh/src/core/viewer/auto-mode.js';

/** 造一块网格（材质可指定） */
function meshWith(material: THREE.Material | THREE.Material[], name = 'mesh'): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  return mesh;
}

/** 造一张「已解码成功」的贴图（不需要真图，image 非空即可） */
function decodedTexture(): THREE.Texture {
  const texture = new THREE.Texture();
  texture.image = { width: 4, height: 4 } as unknown as HTMLImageElement;
  return texture;
}

describe('材质外观判定（materialHasUsableTexture）', () => {
  it('没有贴图的材質 → 无可用外观', () => {
    expect(materialHasUsableTexture(new THREE.MeshStandardMaterial())).toBe(false);
    expect(materialHasUsableTexture(null)).toBe(false);
    expect(materialHasUsableTexture(undefined)).toBe(false);
  });

  it('贴图已解码（image 非空）→ 有可用外观', () => {
    const material = new THREE.MeshStandardMaterial({ map: decodedTexture() });
    expect(materialHasUsableTexture(material)).toBe(true);
  });

  it('贴图存在但 image 为空（three r155+ 解码失败/TGA 等不支持格式）→ 不算有贴图', () => {
    const texture = new THREE.Texture();
    expect(texture.image).toBeNull(); // DEFAULT_IMAGE 默认就是 null（0.6.4 黑剪影的根因）
    expect(materialHasUsableTexture(new THREE.MeshStandardMaterial({ map: texture }))).toBe(false);
  });

  it('顶点色不算可用贴图（游戏资产的顶点色多是暗底，贴图模式仍呈深色剪影 → 素模更清楚）', () => {
    expect(materialHasUsableTexture(new THREE.MeshStandardMaterial({ vertexColors: true }))).toBe(false);
  });
});

describe('场景统计（collectSceneModeFacts）', () => {
  it('纯骨架（只有 Bone）→ meshCount 0', () => {
    const root = new THREE.Object3D();
    const bone = new THREE.Bone();
    root.add(bone);
    expect(collectSceneModeFacts(root)).toEqual({ meshCount: 0, texturedMeshCount: 0 });
  });

  it('无贴图网格：meshCount 1 / textured 0', () => {
    const root = new THREE.Object3D();
    root.add(meshWith(new THREE.MeshStandardMaterial()));
    expect(collectSceneModeFacts(root)).toEqual({ meshCount: 1, texturedMeshCount: 0 });
  });

  it('贴图网格计入 textured；线和点不算 mesh', () => {
    const root = new THREE.Object3D();
    root.add(meshWith(new THREE.MeshStandardMaterial({ map: decodedTexture() })));
    root.add(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()));
    root.add(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial()));
    expect(collectSceneModeFacts(root)).toEqual({ meshCount: 1, texturedMeshCount: 1 });
  });

  it('材质数组里任一有贴图即算（multi-material 网格）', () => {
    const root = new THREE.Object3D();
    root.add(meshWith([new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial({ map: decodedTexture() })]));
    expect(collectSceneModeFacts(root).texturedMeshCount).toBe(1);
  });

  it('素模模式已替换材质时看 userData 里的原始材质（否则有贴图模型会被误判成无贴图）', () => {
    const root = new THREE.Object3D();
    const mesh = meshWith(new THREE.MeshStandardMaterial());
    (mesh.userData as Record<string, unknown>).kinemeshOriginalMaterial = new THREE.MeshStandardMaterial({
      map: decodedTexture(),
    });
    root.add(mesh);
    expect(collectSceneModeFacts(root)).toEqual({ meshCount: 1, texturedMeshCount: 1 });
  });
});

describe('三档判定（suggestModeFromFacts / suggestViewMode）', () => {
  it('无 mesh → skeleton（no-mesh）', () => {
    expect(suggestModeFromFacts({ meshCount: 0, texturedMeshCount: 0 })).toEqual({ mode: 'skeleton', reason: 'no-mesh' });
  });

  it('有 mesh 无贴图 → solid（no-texture）', () => {
    expect(suggestModeFromFacts({ meshCount: 3, texturedMeshCount: 0 })).toEqual({ mode: 'solid', reason: 'no-texture' });
  });

  it('有可用贴图 → default（textured）', () => {
    expect(suggestModeFromFacts({ meshCount: 3, texturedMeshCount: 1 })).toEqual({ mode: 'default', reason: 'textured' });
  });

  it('suggestViewMode 直接吃场景对象（纯骨架场景 → 骨架模式）', () => {
    const rig = new THREE.Object3D();
    rig.add(new THREE.Bone());
    expect(suggestViewMode(rig).mode).toBe('skeleton');

    const textured = new THREE.Object3D();
    textured.add(meshWith(new THREE.MeshStandardMaterial({ map: decodedTexture() })));
    expect(suggestViewMode(textured).mode).toBe('default');

    const plain = new THREE.Object3D();
    plain.add(meshWith(new THREE.MeshStandardMaterial()));
    expect(suggestViewMode(plain).mode).toBe('solid');
  });
});
