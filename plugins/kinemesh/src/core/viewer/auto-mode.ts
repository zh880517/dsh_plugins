// 载入后自动选渲染模式（0.7.1，用户拍板）：
// · 没有 mesh（纯骨架 / 只有空物体 / 形变动画平面之类）→ 骨架模式，否则一片空白看不出东西；
// · 有 mesh 但没有可用贴图（常见：Unity/Max 导出的 FBX 只带材质名、贴图缺失或 TGA 解码失败）→ 素模，
//   贴图模式只会得到一堆灰白/黑块，素模最能看清几何；
// · 有可用贴图 → 贴图模式（`default`），材质信息是真的，没必要盖成素模。
//
// 纯判定逻辑放这里（不碰 WebGL），viewer 在 loadScene 末尾调 `suggestViewMode`，
// client 读 `viewer.modeSuggestion()` 应用；Node 直测见 tests/kinemesh/auto-mode.test.ts。
import * as THREE from 'three';
import type { ViewMode } from '../viewstate.js';

/** 「为什么选了这个模式」——面板上给用户一句人话 */
export type ModeReason = 'no-mesh' | 'no-texture' | 'textured';

export interface SceneModeFacts {
  /** 需要显示的网格数（isMesh；骨骼/空物体/辅助对象不计） */
  meshCount: number;
  /** 其中「贴图真的解码出来了」的网格数 */
  texturedMeshCount: number;
}

export interface ModeSuggestion {
  mode: ViewMode;
  reason: ModeReason;
}

/**
 * 材质是否有可用的**贴图**外观：`map` 且 `map.image` 非空。
 * （three r155+ 的 `Texture.DEFAULT_IMAGE` 是 null，解码失败/不支持的格式——如 FBX 常见的 TGA——
 * 会留下空 image；0.6.4 的黑剪影就是它。真实资产实测：1005_tacy 的 4 张贴图在浏览器里全都解不出来，
 * 于是全部按「无贴图 → 素模」处理，与用户观感一致。）
 *
 * 顶点色**不算**可用贴图：游戏资产的顶点色常是暗色/肤色底，贴图模式下渲染仍是深色剪影，
 * 素模反而更能看清几何与动作（0.7.1 判定口径）。
 */
export function materialHasUsableTexture(material: THREE.Material | null | undefined): boolean {
  if (material === null || material === undefined) return false;
  const withMap = material as { map?: THREE.Texture | null };
  if (withMap.map === undefined || withMap.map === null) return false;
  return withMap.map.image !== null && withMap.map.image !== undefined;
}

/** 统计场景里的网格数与「有贴图/顶点色」的网格数（材质数组任一命中即算） */
export function collectSceneModeFacts(root: THREE.Object3D): SceneModeFacts {
  let meshCount = 0;
  let texturedMeshCount = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    meshCount += 1;
    // 素模模式下 mesh.material 被替换成共享素模材质（没有 map），真实材质存在 userData 里 ——
    // 判定必须看原始材质，否则「已切到 solid 的有贴图模型」会被误判成无贴图
    const stored = (mesh.userData as Record<string, unknown>).kinemeshOriginalMaterial as
      | THREE.Material
      | THREE.Material[]
      | null
      | undefined;
    const source = stored === undefined || stored === null ? mesh.material : stored;
    const materials = Array.isArray(source) ? source : [source];
    if (materials.some((material) => materialHasUsableTexture(material))) texturedMeshCount += 1;
  });
  return { meshCount, texturedMeshCount };
}

/** 三档判定：无 mesh → 骨架；有 mesh 无贴图 → 素模；有贴图 → 贴图模式 */
export function suggestModeFromFacts(facts: SceneModeFacts): ModeSuggestion {
  if (facts.meshCount <= 0) return { mode: 'skeleton', reason: 'no-mesh' };
  if (facts.texturedMeshCount <= 0) return { mode: 'solid', reason: 'no-texture' };
  return { mode: 'default', reason: 'textured' };
}

/** 组合入口：直接对载入的场景对象给出建议 */
export function suggestViewMode(root: THREE.Object3D): ModeSuggestion {
  return suggestModeFromFacts(collectSceneModeFacts(root));
}
