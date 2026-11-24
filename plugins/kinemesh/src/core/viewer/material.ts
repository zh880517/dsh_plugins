// 预览材质兜底（0.6.4，纯函数、Node 可测）：不依赖 WebGL/DOM，viewer 与单测共用。
// 场景：Unity/Max 导出的 FBX 在预览里常呈纯黑剪影，两个成因都能在这里修：
//  ① metalness 过高且无环境贴图 —— 物理光照下材质只反射环境，无环境即纯黑；
//  ② 贴图缺失/解码失败（texture.image 为空）且颜色过暗 —— 任何灯光都照不亮。
// 只修改渲染期材质对象（内存副本），不触碰源文件。
import type * as THREE from 'three';

/** 兜底中性灰：亮到能在深色舞台上看清轮廓，又不至于过曝 */
export const PREVIEW_FALLBACK_COLOR = 0xb9c0cc;

/** metalness 上限：超过它在无环境贴图时几乎全黑 */
export const PREVIEW_METALNESS_MAX = 0.15;
/** roughness 下限：避免镜面高光把形状打散 */
export const PREVIEW_ROUGHNESS_MIN = 0.6;

/**
 * 归一一个材质用于预览显示。返回是否做了修改（便于测试与排查）。
 * Phong/Lambert 等没有 metalness 字段的材质会自动跳过第 ① 步。
 */
export function normalizePreviewMaterial(material: THREE.Material): boolean {
  const standard = material as THREE.MeshStandardMaterial;
  let changed = false;

  if (typeof standard.metalness === 'number' && standard.metalness > PREVIEW_METALNESS_MAX) {
    standard.metalness = PREVIEW_METALNESS_MAX;
    if (typeof standard.roughness === 'number') standard.roughness = Math.max(standard.roughness, PREVIEW_ROUGHNESS_MIN);
    changed = true;
  }

  const map = standard.map as THREE.Texture | null | undefined;
  const hasUsableMap =
    map !== undefined && map !== null && (map as THREE.Texture).image !== undefined && (map as THREE.Texture).image !== null;
  const color = standard.color as THREE.Color | undefined;
  if (!hasUsableMap && color !== undefined && color.getHex() < 0x101010) {
    color.setHex(PREVIEW_FALLBACK_COLOR);
    changed = true;
  }

  if (changed) standard.needsUpdate = true;
  return changed;
}

/** 几何顶点色是否「全零/全暗」——是则材质 vertexColors 应关闭（0.6.5） */
export function isVertexColorAllDark(colorAttribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined): boolean {
  if (colorAttribute === undefined) return false;
  const count = colorAttribute.count;
  if (count === 0) return false;
  const itemSize = colorAttribute.itemSize;
  // 抽样上限 512 个顶点：只看是否「整体暗」，不必遍历全部
  const stride = Math.max(1, Math.floor(count / 512));
  let checked = 0;
  for (let index = 0; index < count; index += stride) {
    let maxComponent = 0;
    for (let component = 0; component < Math.min(itemSize, 3); component += 1) {
      maxComponent = Math.max(maxComponent, colorAttribute.getComponent(index, component));
    }
    if (maxComponent > 0.06) return false;
    checked += 1;
    if (checked >= 512) break;
  }
  return true;
}
